import * as THREE from 'three';
import { addFeatherTufts, createPlumageMaps, type PlumageMaps } from './plumage';

/**
 * Talking Owl is built from local geometry so the preview loads at once.
 * Layered feathers, a heart-shaped facial disc and a small hinged beak give
 * this original character a readable bird silhouette at mobile sizes.
 */

type ActionName =
  | 'idle' | 'newspaper' | 'poke' | 'tickle' | 'eat' | 'sip' | 'burp'
  | 'call' | 'listen' | 'talk' | 'hangup' | 'yes' | 'no' | 'laugh'
  | 'mix' | 'surprise' | 'wave' | 'ponder' | 'gasp' | 'dance' | 'snooze' | 'sing'
  | 'wink' | 'shrug' | 'salute' | 'scratch' | 'yawn' | 'hush' | 'cheer'
  | 'shiver' | 'bow' | 'sneeze';

type LoftStation = { x: number; y: number; z: number; width: number; depth: number };

type Wing = {
  side: -1 | 1;
  surface: THREE.Mesh;
  tip: THREE.Group;
  elbow: THREE.Vector3;
  hand: THREE.Vector3;
  shoulder: THREE.Vector3;
};

const PAPER_CORNER_AXIS = new THREE.Vector3(0.18, -0.22, 0).normalize();
const PHONE_EAR_HAND = new THREE.Vector3(0.73, 1.46, 0.30);
const EAT_DURATION = 2.65;
const SIP_DURATION = 2.45;
const EAT_HAND_PATH = [
  [0, 0.68, 0.24, 0.48], [0.16, 1.00, 0.43, 0.62],
  [0.36, 1.30, 0.30, 0.65], [0.62, 1.10, 0.68, 0.69],
  [0.98, 0.13, 1.26, 0.80], [1.22, 0.09, 1.28, 0.85],
  [1.48, 0.08, 1.28, 0.85], [1.86, 0.50, 1.04, 0.75],
  [2.06, 0.70, 0.82, 0.70], [2.48, 1.30, 0.30, 0.65],
  [2.56, 0.94, 0.38, 0.55],
  [EAT_DURATION, 0.68, 0.24, 0.48],
] as const;
const EAT_ELBOW_PATH = [
  [0, 0.70, 0.58, 0.39], [0.36, 1.02, 0.45, 0.35],
  [0.62, 0.90, 0.65, 0.42], [0.98, 0.61, 0.98, 0.58],
  [1.22, 0.53, 1.04, 0.64], [1.86, 0.55, 1.02, 0.60],
  [2.06, 0.70, 0.84, 0.55],
  [2.48, 1.02, 0.45, 0.35], [2.56, 0.82, 0.55, 0.43],
  [EAT_DURATION, 0.70, 0.58, 0.39],
] as const;
const SIP_HAND_PATH = [
  [0, 0.68, 0.24, 0.48], [0.16, 1.00, 0.43, 0.62],
  [0.36, 1.30, 0.30, 0.65], [0.63, 1.10, 0.68, 0.71],
  [0.99, 0.15, 1.22, 0.78], [1.60, 0.12, 1.23, 0.82],
  [1.85, 0.48, 1.02, 0.75], [2.28, 1.30, 0.30, 0.65],
  [2.36, 0.94, 0.38, 0.55],
  [SIP_DURATION, 0.68, 0.24, 0.48],
] as const;
const SIP_ELBOW_PATH = [
  [0, 0.70, 0.58, 0.39], [0.36, 1.02, 0.45, 0.36],
  [0.63, 0.90, 0.65, 0.43], [0.99, 0.61, 0.98, 0.58],
  [1.60, 0.53, 1.04, 0.64], [1.85, 0.55, 1.02, 0.60],
  [2.02, 0.70, 0.83, 0.55],
  [2.28, 1.02, 0.45, 0.36], [2.36, 0.82, 0.55, 0.43],
  [SIP_DURATION, 0.70, 0.58, 0.39],
] as const;
const FUR = new THREE.MeshPhysicalMaterial({
  color: 0x98674b, roughness: 0.94, metalness: 0,
  sheen: 0.46, sheenColor: new THREE.Color(0xe1b992), sheenRoughness: 0.96,
});
const HEAD_FUR = FUR.clone();
HEAD_FUR.emissive.setHex(0x694328);
HEAD_FUR.emissiveIntensity = 0.34;
const FUR_LIGHT = new THREE.MeshPhysicalMaterial({
  color: 0xe9d3a6, roughness: 0.96, metalness: 0,
  sheen: 0.37, sheenColor: new THREE.Color(0xfff3d8), sheenRoughness: 0.98,
});
const FUR_SHADE = new THREE.MeshPhysicalMaterial({
  color: 0x754b3f, roughness: 0.95, metalness: 0,
  sheen: 0.38, sheenColor: new THREE.Color(0xc79374), sheenRoughness: 0.97,
});
const WING_RUSSET = new THREE.MeshPhysicalMaterial({
  color: 0x95694d, roughness: 0.96, metalness: 0,
  sheen: 0.34, sheenColor: new THREE.Color(0xb58769), sheenRoughness: 0.98,
  side: THREE.DoubleSide,
});
const EAR_DARK = new THREE.MeshPhysicalMaterial({
  color: 0x533b37, roughness: 0.93, metalness: 0,
  sheen: 0.42, sheenColor: new THREE.Color(0xa67a5d), sheenRoughness: 0.96,
});
const DISC_RIM = new THREE.MeshPhysicalMaterial({ color: 0x875b46, roughness: 0.95, sheen: 0.28 });
const DISC_CREAM = new THREE.MeshPhysicalMaterial({ color: 0xe8d6b1, roughness: 0.96, sheen: 0.28 });
const TALON = new THREE.MeshPhysicalMaterial({
  color: 0xe2ad4e, roughness: 0.90, metalness: 0,
  sheen: 0.05, sheenColor: new THREE.Color(0xac7847), sheenRoughness: 0.96,
});
const CLAW = new THREE.MeshStandardMaterial({ color: 0x795c49, roughness: 0.91 });
const TRACK_RED = new THREE.MeshPhysicalMaterial({
  color: 0xef223a, roughness: 0.91, metalness: 0,
  sheen: 0.15, sheenColor: new THREE.Color(0xff8b8e), sheenRoughness: 0.96,
  side: THREE.DoubleSide,
});
const TRACK_SHADE = new THREE.MeshStandardMaterial({ color: 0xdb132a, roughness: 0.93 });
const TRACK_WHITE = new THREE.MeshStandardMaterial({ color: 0xfff7ee, roughness: 0.85 });
const PHONE_DARK = new THREE.MeshStandardMaterial({ color: 0x163c43, roughness: 0.78 });
const PHONE_DETAIL = new THREE.MeshStandardMaterial({ color: 0x83a59b, roughness: 0.68, metalness: 0.1 });
const BRASS = new THREE.MeshStandardMaterial({ color: 0xc5a36f, roughness: 0.36, metalness: 0.69 });
const BEAK = new THREE.MeshPhysicalMaterial({
  color: 0xd88930, roughness: 0.59, metalness: 0,
  clearcoat: 0.18, clearcoatRoughness: 0.38,
});
const BEAK_LIGHT = new THREE.MeshPhysicalMaterial({ color: 0xeda74a, roughness: 0.58, clearcoat: 0.11 });
const MOUTH = new THREE.MeshStandardMaterial({ color: 0x382624, roughness: 0.94 });
const EYE_RIM = new THREE.MeshStandardMaterial({ color: 0x85634b, roughness: 0.94 });
const IRIS = new THREE.MeshPhysicalMaterial({ color: 0xd99537, roughness: 0.62, clearcoat: 0.22 });
const IRIS_GOLD = new THREE.MeshStandardMaterial({ color: 0xf4c266, roughness: 0.72 });
const PUPIL = new THREE.MeshPhysicalMaterial({ color: 0x231f22, roughness: 0.31, clearcoat: 0.33 });
const EYE_GLINT = new THREE.MeshBasicMaterial({ color: 0xffffff });
const SHARED_MATERIALS = new Set<THREE.Material>([
  FUR, HEAD_FUR, FUR_LIGHT, FUR_SHADE, WING_RUSSET, EAR_DARK, DISC_RIM, DISC_CREAM, TALON, CLAW,
  TRACK_RED, TRACK_SHADE, TRACK_WHITE, PHONE_DARK, PHONE_DETAIL,
  BRASS, BEAK, BEAK_LIGHT, MOUTH, EYE_RIM,
  IRIS, IRIS_GOLD, PUPIL, EYE_GLINT,
]);
const COAT_MATERIALS = [FUR, HEAD_FUR, FUR_LIGHT, FUR_SHADE, WING_RUSSET, EAR_DARK];
let sharedPlumageMaps: PlumageMaps | undefined;
let plumageMapUsers = 0;

function acquirePlumageMaps(): PlumageMaps {
  if (!sharedPlumageMaps) {
    sharedPlumageMaps = createPlumageMaps();
    for (const material of COAT_MATERIALS) {
      material.map = sharedPlumageMaps.colorMap;
      material.bumpMap = sharedPlumageMaps.bumpMap;
      material.bumpScale = sharedPlumageMaps.bumpScale;
      material.needsUpdate = true;
    }
  }
  plumageMapUsers++;
  return sharedPlumageMaps;
}

function releasePlumageMaps(maps: PlumageMaps): void {
  if (sharedPlumageMaps !== maps || --plumageMapUsers > 0) return;
  for (const material of COAT_MATERIALS) {
    material.map = null;
    material.bumpMap = null;
    material.needsUpdate = true;
  }
  maps.dispose();
  sharedPlumageMaps = undefined;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function damp(current: number, target: number, dt: number, rate = 10): number {
  return THREE.MathUtils.lerp(current, target, 1 - Math.exp(-rate * dt));
}

function smoothStep(t: number): number {
  const n = clamp(t, 0, 1);
  return n * n * (3 - 2 * n);
}

function bell(t: number): number {
  return Math.sin(Math.PI * smoothStep(t));
}

function holdEnvelope(age: number, duration: number, attack = 0.22, release = 0.28): number {
  return smoothStep(age / attack) * smoothStep((duration - age) / release);
}

function stagedPoint(age: number, frames: ReadonlyArray<readonly [number, number, number, number]>): THREE.Vector3 {
  for (let index = 1; index < frames.length; index++) {
    const before = frames[index - 1]!;
    const after = frames[index]!;
    if (age > after[0]) continue;
    const blend = smoothStep((age - before[0]) / (after[0] - before[0]));
    return point(
      THREE.MathUtils.lerp(before[1], after[1], blend),
      THREE.MathUtils.lerp(before[2], after[2], blend),
      THREE.MathUtils.lerp(before[3], after[3], blend),
    );
  }
  const last = frames[frames.length - 1]!;
  return point(last[1], last[2], last[3]);
}

function mesh(
  parent: THREE.Object3D,
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  name: string,
): THREE.Mesh {
  const result = new THREE.Mesh(geometry, material);
  result.name = name;
  result.castShadow = true;
  result.receiveShadow = true;
  parent.add(result);
  return result;
}

function ellipsoid(
  parent: THREE.Object3D,
  material: THREE.Material,
  name: string,
  x: number, y: number, z: number,
  rx: number, ry: number, rz: number,
  segments = 28,
): THREE.Mesh {
  const result = mesh(parent, new THREE.SphereGeometry(1, segments, Math.max(12, Math.round(segments * 0.7))), material, name);
  result.position.set(x, y, z);
  result.scale.set(rx, ry, rz);
  return result;
}

function curve(
  parent: THREE.Object3D,
  points: THREE.Vector3[],
  radius: number,
  material: THREE.Material,
  name: string,
  segments = 24,
): THREE.Mesh {
  const path = new THREE.CatmullRomCurve3(points);
  return mesh(parent, new THREE.TubeGeometry(path, segments, radius, 7, false), material, name);
}

function taperedCurve(
  parent: THREE.Object3D, points: THREE.Vector3[], radii: number[],
  material: THREE.Material, name: string,
): THREE.Mesh {
  const path = new THREE.CatmullRomCurve3(points);
  const tubularSegments = 40;
  const radialSegments = 12;
  const geometry = new THREE.TubeGeometry(path, tubularSegments, 1, radialSegments, false);
  const position = geometry.attributes.position as THREE.BufferAttribute;
  for (let ring = 0; ring <= tubularSegments; ring++) {
    const t = ring / tubularSegments;
    const center = path.getPointAt(t);
    const station = t * (radii.length - 1);
    const index = Math.min(radii.length - 2, Math.floor(station));
    const radius = THREE.MathUtils.lerp(radii[index]!, radii[index + 1]!, smoothStep(station - index));
    for (let vertex = 0; vertex <= radialSegments; vertex++) {
      const indexInGeometry = ring * (radialSegments + 1) + vertex;
      const direction = point(
        position.getX(indexInGeometry) - center.x,
        position.getY(indexInGeometry) - center.y,
        position.getZ(indexInGeometry) - center.z,
      );
      position.setXYZ(indexInGeometry,
        center.x + direction.x * radius,
        center.y + direction.y * radius,
        center.z + direction.z * radius);
    }
  }
  position.needsUpdate = true;
  geometry.computeVertexNormals();
  return mesh(parent, geometry, material, name);
}

function point(x: number, y: number, z: number): THREE.Vector3 {
  return new THREE.Vector3(x, y, z);
}

/** The bitten silhouette removes a soft scallop on the side facing his mouth. */
function cookieCrustGeometry(bitten: boolean): THREE.ExtrudeGeometry {
  const outline = new THREE.Shape();
  for (let index = 0; index <= 48; index++) {
    const angle = index * Math.PI * 2 / 48;
    const uneven = 1 + Math.sin(angle * 7 + 2.7) * 0.036
      + Math.sin(angle * 11 + 4.59) * 0.024;
    const biteAngle = Math.atan2(Math.sin(angle - Math.PI), Math.cos(angle - Math.PI));
    const notch = bitten ? 0.083 * Math.exp(-Math.pow(biteAngle / 0.38, 2)) : 0;
    const radius = 0.177 * uneven - notch;
    const x = Math.cos(angle) * radius;
    const y = Math.sin(angle) * radius;
    if (index === 0) outline.moveTo(x, y);
    else outline.lineTo(x, y);
  }
  return new THREE.ExtrudeGeometry(outline, {
    depth: 0.047, bevelEnabled: true, bevelThickness: 0.011,
    bevelSize: 0.008, bevelSegments: 2, steps: 1,
  });
}

/** Rounded, bent volume used for the ears and small feather points. */
function loft(stations: LoftStation[], radialSegments = 18): THREE.BufferGeometry {
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const centerline = new THREE.CatmullRomCurve3(stations.map(station => point(station.x, station.y, station.z)));
  const scalarAt = (key: 'width' | 'depth', t: number): number => {
    const p = t * (stations.length - 1);
    const i = Math.min(stations.length - 2, Math.floor(p));
    const fraction = p - i;
    const a = stations[Math.max(0, i - 1)]![key];
    const b = stations[i]![key];
    const c = stations[i + 1]![key];
    const d = stations[Math.min(stations.length - 1, i + 2)]![key];
    const m0 = (c - a) * 0.5;
    const m1 = (d - b) * 0.5;
    const f2 = fraction * fraction;
    const f3 = f2 * fraction;
    return Math.max(0.002, (2 * f3 - 3 * f2 + 1) * b + (f3 - 2 * f2 + fraction) * m0 + (-2 * f3 + 3 * f2) * c + (f3 - f2) * m1);
  };
  const rings = (stations.length - 1) * 4 + 1;
  for (let ring = 0; ring < rings; ring++) {
    const t = ring / (rings - 1);
    const center = centerline.getPoint(t);
    const width = scalarAt('width', t);
    const depth = scalarAt('depth', t);
    for (let i = 0; i < radialSegments; i++) {
      const a = i / radialSegments * Math.PI * 2;
      positions.push(
        center.x + Math.cos(a) * width,
        center.y,
        center.z + Math.sin(a) * depth,
      );
      uvs.push(i / radialSegments, t);
    }
  }
  for (let j = 0; j < rings - 1; j++) {
    for (let i = 0; i < radialSegments; i++) {
      const a = j * radialSegments + i;
      const b = j * radialSegments + (i + 1) % radialSegments;
      const c = (j + 1) * radialSegments + i;
      const d = (j + 1) * radialSegments + (i + 1) % radialSegments;
      if (stations[stations.length - 1]!.y < stations[0]!.y) indices.push(a, b, c, b, d, c);
      else indices.push(a, c, b, b, c, d);
    }
  }
  for (let i = 1; i < radialSegments - 1; i++) {
    indices.push(0, i, i + 1);
    const end = (rings - 1) * radialSegments;
    indices.push(end, end + i + 1, end + i);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function feather(
  parent: THREE.Object3D,
  material: THREE.Material,
  name: string,
  root: THREE.Vector3,
  tip: THREE.Vector3,
  halfWidth: number,
  depth = 0.045,
): THREE.Mesh {
  const at = (t: number): THREE.Vector3 => root.clone().lerp(tip, t);
  const stations = [
    { t: 0, width: halfWidth * 0.28, thickness: depth * 0.70 },
    { t: 0.18, width: halfWidth * 0.78, thickness: depth },
    { t: 0.52, width: halfWidth, thickness: depth * 0.82 },
    { t: 0.80, width: halfWidth * 0.66, thickness: depth * 0.48 },
    { t: 1, width: 0.006, thickness: 0.006 },
  ].map(({ t, width, thickness }) => {
    const place = at(t);
    return { x: place.x, y: place.y, z: place.z, width, depth: thickness };
  });
  return mesh(parent, loft(stations, 14), material, name);
}

function sculptHead(): THREE.BufferGeometry {
  const geometry = new THREE.SphereGeometry(1, 48, 36);
  const positions = geometry.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < positions.count; i++) {
    const nx = positions.getX(i);
    const ny = positions.getY(i);
    const nz = positions.getZ(i);
    const crown = Math.exp(-Math.pow((ny - 0.34) / 0.49, 2));
    const lower = Math.max(0, -ny);
    const crownLift = 0.068 * smoothStep((ny - 0.20) / 0.80);
    const warmLowerFace = Math.exp(-Math.pow((ny + 0.57) / 0.30, 2))
      * Math.exp(-Math.pow(nx / 0.72, 2)) * Math.max(0, nz);
    positions.setXYZ(
      i,
      nx * (0.70 + crown * 0.035 - lower * 0.038),
      ny * (ny < 0 ? 0.50 : 0.67) + crownLift,
      nz * (0.55 - Math.max(0, nz) * 0.035) + 0.145 * warmLowerFace,
    );
  }
  positions.needsUpdate = true;
  geometry.computeVertexNormals();
  return geometry;
}

const WING_RINGS = 24;
const WING_RADIAL = 20;

/** One deforming feather volume keeps the root, bend, and tip continuous. */
function wingSurfaceGeometry(): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  const positions = new Float32Array((WING_RINGS + 1) * WING_RADIAL * 3);
  const uvs = new Float32Array((WING_RINGS + 1) * WING_RADIAL * 2);
  const indices: number[] = [];
  for (let ring = 0; ring <= WING_RINGS; ring++) {
    for (let radial = 0; radial < WING_RADIAL; radial++) {
      const vertex = ring * WING_RADIAL + radial;
      uvs[vertex * 2] = radial / WING_RADIAL;
      uvs[vertex * 2 + 1] = ring / WING_RINGS;
      if (ring === WING_RINGS) continue;
      const next = ring * WING_RADIAL + (radial + 1) % WING_RADIAL;
      const below = (ring + 1) * WING_RADIAL + radial;
      const diagonal = (ring + 1) * WING_RADIAL + (radial + 1) % WING_RADIAL;
      indices.push(vertex, next, below, next, diagonal, below);
    }
  }
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  return geometry;
}

function bendWing(surface: THREE.Mesh, side: -1 | 1, root: THREE.Vector3,
  elbow: THREE.Vector3, tip: THREE.Vector3, widthScale = 1, foldWeight = 1): void {
  const path = new THREE.CatmullRomCurve3([root, elbow, tip], false, 'centripetal');
  const widthProfile = [0.075, 0.20, 0.23, 0.20, 0.15, 0.11, 0.075];
  const depthProfile = [0.045, 0.090, 0.108, 0.090, 0.070, 0.052, 0.040];
  const foldedWidthProfile = [0.075, 0.17, 0.15, 0.12, 0.09, 0.070, 0.048];
  const foldedDepthProfile = [0.045, 0.075, 0.074, 0.063, 0.050, 0.038, 0.026];
  const projectedSpan = Math.hypot(tip.x - root.x, tip.y - root.y);
  const fold = (1 - smoothStep((projectedSpan - 0.34) / 0.50)) * foldWeight;
  const profile = (values: number[], t: number): number => {
    const station = t * (values.length - 1);
    const index = Math.min(values.length - 2, Math.floor(station));
    return THREE.MathUtils.lerp(values[index]!, values[index + 1]!, smoothStep(station - index));
  };
  const positions = surface.geometry.attributes.position as THREE.BufferAttribute;
  const acrossAxis = point(1, 0, 0);
  const frameRotation = new THREE.Quaternion();
  let previousTangent: THREE.Vector3 | undefined;
  for (let ring = 0; ring <= WING_RINGS; ring++) {
    const t = ring / WING_RINGS;
    const center = path.getPoint(t);
    const tangent = path.getTangent(t).normalize();
    if (previousTangent) {
      frameRotation.setFromUnitVectors(previousTangent, tangent);
      acrossAxis.applyQuaternion(frameRotation);
    } else {
      acrossAxis.set(-tangent.y, tangent.x, 0);
      if (acrossAxis.lengthSq() < 0.0001) acrossAxis.set(1, 0, 0);
      acrossAxis.normalize();
      if (acrossAxis.x < 0) acrossAxis.negate();
    }
    const frontFacing = point(-tangent.y, tangent.x, 0);
    if (frontFacing.lengthSq() > 0.02) {
      frontFacing.normalize();
      if (frontFacing.dot(acrossAxis) < 0) frontFacing.negate();
      acrossAxis.lerp(frontFacing, 0.16);
    }
    acrossAxis.addScaledVector(tangent, -acrossAxis.dot(tangent)).normalize();
    const depthAxis = point(0, 0, 0).crossVectors(tangent, acrossAxis).normalize();
    previousTangent = tangent;
    const roundedEnd = t > 0.92
      ? Math.sqrt(Math.max(0.0004, 1 - Math.pow((t - 0.92) / 0.08, 2))) : 1;
    const gripNarrowing = THREE.MathUtils.lerp(1, widthScale,
      smoothStep((t - 0.32) / 0.52));
    const width = THREE.MathUtils.lerp(profile(widthProfile, t),
      profile(foldedWidthProfile, t), fold) * roundedEnd * gripNarrowing;
    const depth = THREE.MathUtils.lerp(profile(depthProfile, t),
      profile(foldedDepthProfile, t), fold) * roundedEnd * gripNarrowing;
    // Two shallow ridges along the outer edge suggest layered flight feathers
    // without separate digit meshes at the tip.
    const scallops = (0.009 * Math.exp(-Math.pow((t - 0.72) / 0.065, 2))
      + 0.011 * Math.exp(-Math.pow((t - 0.85) / 0.060, 2))) * (1 - fold * 0.65);
    for (let radial = 0; radial < WING_RADIAL; radial++) {
      const angle = radial / WING_RADIAL * Math.PI * 2;
      const across = Math.cos(angle);
      const outer = Math.max(0, side * across);
      const lateral = across * width + side * outer * scallops * gripNarrowing;
      const depthOffset = Math.sin(angle) * depth;
      positions.setXYZ(ring * WING_RADIAL + radial,
        center.x + acrossAxis.x * lateral + depthAxis.x * depthOffset,
        center.y + acrossAxis.y * lateral + depthAxis.y * depthOffset,
        center.z + acrossAxis.z * lateral + depthAxis.z * depthOffset);
    }
  }
  positions.needsUpdate = true;
  surface.geometry.computeVertexNormals();
  surface.geometry.computeBoundingSphere();
}

function paperTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 1024;
  canvas.height = 664;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.fillStyle = '#eee6d3';
    ctx.fillRect(0, 0, 1024, 664);
    // Fine fibers and restrained ink give this page a printed miniature feel.
    let seed = 2173;
    for (let i = 0; i < 1800; i++) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      const x = seed % 1024;
      seed = (seed * 1664525 + 1013904223) >>> 0;
      const y = seed % 664;
      ctx.fillStyle = i % 3 === 0 ? 'rgba(126,112,84,.07)' : 'rgba(255,255,255,.17)';
      ctx.fillRect(x, y, 2 + i % 4, 1);
    }
    ctx.fillStyle = '#38504a';
    ctx.fillRect(36, 34, 952, 5);
    ctx.font = '700 57px Georgia, serif';
    ctx.textAlign = 'center';
    ctx.fillText('THE EVENING HOOT', 512, 99);
    ctx.font = '17px Georgia, serif';
    ctx.fillText('VOLUME IX  ·  OWL HOUSE  ·  FIVE BISCUITS', 512, 129);
    ctx.fillRect(36, 142, 952, 3);
    ctx.textAlign = 'left';
    ctx.font = '700 45px Georgia, serif';
    ctx.fillText('A Most Peculiar', 52, 207);
    ctx.fillText('Night Indeed', 52, 257);
    ctx.font = 'italic 18px Georgia, serif';
    ctx.fillText('Editorial desk reports unusual happenings.', 54, 290);
    ctx.fillStyle = '#a0aa9b';
    ctx.fillRect(552, 170, 390, 212);
    ctx.fillStyle = '#765548';
    ctx.beginPath();
    ctx.ellipse(748, 285, 106, 90, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#e5d1aa';
    for (const x of [713, 783]) {
      ctx.beginPath();
      ctx.ellipse(x, 268, 47, 55, x < 750 ? 0.14 : -0.14, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = '#4d3b36';
    for (const x of [715, 781]) {
      ctx.beginPath();
      ctx.arc(x, 261, 17, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = '#d99942';
    ctx.beginPath();
    ctx.moveTo(748, 278);
    ctx.lineTo(735, 294);
    ctx.lineTo(748, 309);
    ctx.lineTo(761, 294);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#765548';
    for (const side of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(748 + side * 73, 234);
      ctx.lineTo(748 + side * 104, 181);
      ctx.lineTo(748 + side * 45, 210);
      ctx.closePath();
      ctx.fill();
    }
    ctx.fillRect(36, 400, 952, 2);
    for (let col = 0; col < 3; col++) {
      const x = 48 + col * 325;
      for (let row = 0; row < 14; row++) {
        ctx.fillStyle = row % 5 === 0 ? 'rgba(65,77,66,.74)' : 'rgba(65,77,66,.5)';
        ctx.fillRect(x, 421 + row * 16, (row + col) % 4 === 0 ? 245 : 288, row % 5 === 0 ? 5 : 3);
      }
    }
    ctx.fillStyle = '#38504a';
    ctx.fillRect(36, 646, 952, 4);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  return texture;
}

/** One gently bowed half-sheet, with UVs in the corresponding newspaper column. */
function paperLeafGeometry(side: -1 | 1, layer = 0, size = 1): THREE.BufferGeometry {
  const across = 14;
  const down = 10;
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  for (let row = 0; row <= down; row++) {
    const v = row / down;
    for (let column = 0; column <= across; column++) {
      const u = column / across;
      const x = side * 0.735 * size * u;
      const y = (v - 0.5) * 0.93 * size;
      const edgeCurl = 0.024 * Math.pow(u, 3) * (0.5 + v * 0.5);
      const spineBow = 0.015 * Math.sin(u * Math.PI);
      const z = 0.028 - layer * 0.016 + edgeCurl + spineBow;
      positions.push(x, y, z);
      uvs.push((x + 0.735) / 1.47, v);
    }
  }
  for (let row = 0; row < down; row++) {
    for (let column = 0; column < across; column++) {
      const a = row * (across + 1) + column;
      const b = a + 1;
      const c = a + across + 1;
      const d = c + 1;
      if (side < 0) indices.push(a, c, b, b, c, d);
      else indices.push(a, b, c, b, d, c);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function foldedCornerGeometry(): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([
    0, 0.16, 0,
    0.18, -0.06, 0,
    0.18, 0.16, 0,
  ], 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute([0, 1, 1, 0, 1, 1], 2));
  geometry.setIndex([0, 1, 2]);
  geometry.computeVertexNormals();
  return geometry;
}

const JACKET_PROFILE: LoftStation[] = [
  { x: 0, y: 0.135, z: -0.035, width: 0.670, depth: 0.520 },
  { x: 0, y: 0.205, z: -0.035, width: 0.710, depth: 0.555 },
  { x: 0, y: 0.290, z: -0.035, width: 0.770, depth: 0.605 },
  { x: 0, y: 0.48, z: -0.035, width: 0.825, depth: 0.610 },
  { x: 0, y: 0.68, z: -0.035, width: 0.825, depth: 0.630 },
  { x: 0, y: 0.86, z: -0.035, width: 0.595, depth: 0.550 },
  { x: 0, y: 1.02, z: -0.035, width: 0.420, depth: 0.465 },
  { x: 0, y: 1.105, z: -0.035, width: 0.365, depth: 0.385 },
];

function jacketFrontZ(x: number, y: number): number {
  const matching = JACKET_PROFILE.findIndex(station => station.y >= y);
  const upper = matching < 0 ? JACKET_PROFILE.length - 1 : matching;
  const first = JACKET_PROFILE[Math.max(0, upper - 1)]!;
  const second = JACKET_PROFILE[Math.max(0, upper)] ?? JACKET_PROFILE[JACKET_PROFILE.length - 1]!;
  const t = first === second ? 0 : clamp((y - first.y) / (second.y - first.y), 0, 1);
  const width = THREE.MathUtils.lerp(first.width, second.width, t);
  const depth = THREE.MathUtils.lerp(first.depth, second.depth, t);
  return first.z + depth * Math.sqrt(Math.max(0.04, 1 - Math.pow(x / width, 2)));
}

function curvedJacketHem(geometry: THREE.BufferGeometry): THREE.BufferGeometry {
  const positions = geometry.attributes.position as THREE.BufferAttribute;
  for (let index = 0; index < positions.count; index++) {
    const x = positions.getX(index);
    const y = positions.getY(index);
    const z = positions.getZ(index);
    if (y > 0.29) continue;
    const front = clamp((z + 0.035) / 0.56, 0, 1);
    const center = Math.max(0, 1 - Math.pow(x / 0.73, 2));
    const end = smoothStep((0.29 - y) / 0.22);
    positions.setY(index, y - 0.040 * front * center * end);
  }
  positions.needsUpdate = true;
  geometry.computeVertexNormals();
  return geometry;
}

export class OwlCharacter {
  readonly group = new THREE.Group();

  private readonly torsoRig = new THREE.Group();
  private readonly headRig = new THREE.Group();
  private readonly tailRig = new THREE.Group();
  private readonly leftEar = new THREE.Group();
  private readonly rightEar = new THREE.Group();
  private readonly leftBrow = new THREE.Group();
  private readonly rightBrow = new THREE.Group();
  private readonly leftEye = new THREE.Group();
  private readonly rightEye = new THREE.Group();
  private readonly leftIris = new THREE.Group();
  private readonly rightIris = new THREE.Group();
  private readonly upperBeakRig = new THREE.Group();
  private readonly mouthRig = new THREE.Group();
  private readonly paper = new THREE.Group();
  private readonly leftPage = new THREE.Group();
  private readonly rightPage = new THREE.Group();
  private readonly loosePage = new THREE.Group();
  private readonly paperCorner = new THREE.Group();
  private readonly phone = new THREE.Group();
  private readonly biscuit = new THREE.Group();
  private readonly wholeBiscuit = new THREE.Group();
  private readonly bittenBiscuit = new THREE.Group();
  private readonly biscuitCrumbs = new THREE.Group();
  private readonly mug = new THREE.Group();
  private readonly mugTeaSurface = new THREE.Group();
  private readonly flask = new THREE.Group();
  private readonly leftWing: Wing;
  private readonly rightWing: Wing;
  private readonly lookTarget = new THREE.Vector2();
  private readonly lookCurrent = new THREE.Vector2();
  private readonly plumageMaps: PlumageMaps;
  private readonly phoneGripTarget = PHONE_EAR_HAND.clone();
  private action: ActionName = 'idle';
  private actionAge = 0;
  private elapsedInternal = 0;
  private paperMotion = 0;
  private paperTarget: 0 | 1 = 0;
  private pendingAction: ActionName | null = null;
  private lastHeadX = 0;
  private lastHeadZ = 0;
  private callHeld = false;
  private disposed = false;

  constructor() {
    this.plumageMaps = acquirePlumageMaps();
    this.group.name = 'Talking Owl';
    this.group.userData.character = 'owl';
    this.buildTail();
    this.buildLegs();
    this.torsoRig.position.y = 0.9;
    this.group.add(this.torsoRig);
    this.buildTorso();
    this.headRig.position.set(0, 1.055, 0.015);
    this.torsoRig.add(this.headRig);
    this.buildHead();
    this.leftWing = this.buildWing(-1);
    this.rightWing = this.buildWing(1);
    this.buildPaper();
    this.buildHandProps();
    this.update(0.016, 0);
  }

  private buildTail(): void {
    // Three soft tail plumes fold behind the jacket and flick up for a laugh.
    this.tailRig.position.set(0.11, 0.93, -0.39);
    this.tailRig.scale.set(0.53, 0.56, 1);
    this.tailRig.userData.action = 'tickle';
    this.group.add(this.tailRig);
    for (const feather of [-1, 0, 1]) {
      const plume = ellipsoid(this.tailRig,
        feather === 0 ? FUR_SHADE : FUR, 'rounded tail plume',
        0.34, feather * 0.035, feather === 0 ? 0.025 : -0.005,
        0.37, 0.075, 0.038, 24);
      plume.rotation.z = 0.07 + feather * 0.22;
      plume.castShadow = false;
      plume.userData.action = 'tickle';
    }
  }

  private buildLegs(): void {
    for (const side of [-1, 1] as const) {
      const x = side * 0.43;
      // A very short shank disappears into the jacket, and the three toes
      // settle on the front lip of the chair cushion.
      taperedCurve(this.group, [
        point(x, 1.018, 0.215), point(x, 0.974, 0.300), point(x, 0.946, 0.355),
      ], [0.031, 0.027, 0.028], TALON, 'tiny tucked owl ankle')
        .userData.action = 'poke';
      ellipsoid(this.group, TALON, 'narrow connected owl toe base',
        x, 0.944, 0.364, 0.090, 0.025, 0.069, 22).userData.action = 'poke';
      for (const toe of [-1, 0, 1]) {
        const spread = toe * 0.087;
        taperedCurve(this.group, [
          point(x + spread * 0.35, 0.947, 0.390),
          point(x + spread * 0.90, 0.934, 0.462),
          point(x + spread * 1.13, 0.919, 0.544 + (toe === 0 ? 0.010 : 0)),
        ], [0.031, 0.024, 0.006], TALON, 'small perched owl toe')
          .userData.action = 'poke';
        const claw = ellipsoid(this.group, CLAW, 'tiny flush owl claw tip',
          x + spread * 1.13, 0.919, 0.544 + (toe === 0 ? 0.010 : 0),
          0.008, 0.005, 0.012, 12);
        claw.rotation.y = toe * 0.14;
        claw.userData.action = 'poke';
      }
    }
  }

  private buildTorso(): void {
    // A clean red shell around the round torso leaves the small wings and
    // perching toes visible; the recessed body never pierces the fabric.
    ellipsoid(this.torsoRig, FUR, 'plump body beneath jacket',
      0, 0.56, -0.070, 0.68, 0.41, 0.46, 40).userData.action = 'tickle';
    mesh(this.torsoRig, curvedJacketHem(loft(JACKET_PROFILE, 48)),
      TRACK_RED, 'fitted Twilio red track jacket').userData.action = 'tickle';
    mesh(this.torsoRig, curvedJacketHem(loft([
      { x: 0, y: 0.128, z: -0.035, width: 0.678, depth: 0.530 },
      { x: 0, y: 0.169, z: -0.035, width: 0.696, depth: 0.547 },
      { x: 0, y: 0.208, z: -0.035, width: 0.711, depth: 0.566 },
    ], 48)), TRACK_SHADE, 'gently curved ribbed jacket hem');
    mesh(this.torsoRig, loft([
      { x: 0, y: 1.045, z: -0.035, width: 0.465, depth: 0.455 },
      { x: 0, y: 1.080, z: -0.035, width: 0.417, depth: 0.426 },
      { x: 0, y: 1.125, z: -0.035, width: 0.370, depth: 0.394 },
    ], 42), TRACK_SHADE, 'raised track jacket collar');

    const zipperLine = Array.from({ length: 24 }, (_, index) => {
      const y = 1.102 - index / 23 * 0.849;
      const surface = jacketFrontZ(0, y) + (y > 1.045 ? 0.047 : 0.025);
      return point(0, y, surface);
    });
    curve(this.torsoRig, zipperLine, 0.022, TRACK_SHADE, 'flat jacket zipper tape', 34);
    curve(this.torsoRig, zipperLine.map(v => point(0, v.y, v.z + 0.018)),
      0.008, TRACK_WHITE, 'white track jacket zipper', 34);
    ellipsoid(this.torsoRig, TRACK_WHITE, 'small zipper pull',
      0, 0.996, jacketFrontZ(0, 0.996) + 0.063, 0.018, 0.029, 0.009, 16);

    // Upload a canvas copy of the official SVG: WebGL cannot upload SVG pixels
    // directly in all browsers. Its transparent viewBox is cropped to the bug.
    const badgeCanvas = document.createElement('canvas');
    badgeCanvas.width = badgeCanvas.height = 256;
    const badgeTexture = new THREE.CanvasTexture(badgeCanvas);
    badgeTexture.colorSpace = THREE.SRGBColorSpace;
    const badgeImage = new Image();
    badgeImage.onload = () => {
      if (this.disposed) return;
      const ctx = badgeCanvas.getContext('2d');
      if (!ctx) return;
      const source = document.createElement('canvas');
      source.width = source.height = 512;
      const sourceContext = source.getContext('2d');
      if (!sourceContext) return;
      sourceContext.drawImage(badgeImage, 0, 0, 512, 512);
      ctx.clearRect(0, 0, 256, 256);
      ctx.drawImage(source,
        33.22 / 147.32 * 512, 32.80 / 146.60 * 512,
        81 / 147.32 * 512, 81 / 146.60 * 512,
        0, 0, 256, 256);
      badgeTexture.needsUpdate = true;
    };
    badgeImage.src = '/brand/Twilio_Logo_Bug_White.svg';
    const badgeMaterial = new THREE.MeshBasicMaterial({
      map: badgeTexture, transparent: true, depthWrite: false, toneMapped: false,
      side: THREE.DoubleSide,
    });
    const badgeCenter = point(-0.307, 0.757, 0);
    const badgeGeometry = new THREE.PlaneGeometry(0.135, 0.135, 8, 8);
    const badgeVertices = badgeGeometry.attributes.position as THREE.BufferAttribute;
    for (let index = 0; index < badgeVertices.count; index++) {
      const x = badgeCenter.x + badgeVertices.getX(index);
      const y = badgeCenter.y + badgeVertices.getY(index);
      badgeVertices.setZ(index, jacketFrontZ(x, y) + 0.055);
    }
    badgeVertices.needsUpdate = true;
    badgeGeometry.computeVertexNormals();
    const badge = mesh(this.torsoRig, badgeGeometry,
      badgeMaterial, 'official white Twilio bug chest print');
    badge.position.set(badgeCenter.x, badgeCenter.y, 0);
    badge.castShadow = false;
    badge.receiveShadow = false;
  }

  private buildHead(): void {
    const head = mesh(this.headRig, sculptHead(), HEAD_FUR, 'rounded owl head');
    head.position.y = 0.55;
    head.receiveShadow = false;
    head.userData.action = 'poke';
    addFeatherTufts(this.headRig, {
      name: 'soft crown down', material: FUR,
      center: [0, 0.55, 0], radii: [0.72, 0.73, 0.55],
      count: 35, length: 0.072, width: 0.043, seed: 8517,
      normalBias: [0, 0.80, 0.03], normalCutoff: 0.48,
      groom: [0, 0.68, 0.08],
    });

    // Two feather tufts provide the familiar owl silhouette without pink ears.
    for (const side of [-1, 1] as const) {
      const tuftRig = side < 0 ? this.leftEar : this.rightEar;
      tuftRig.position.set(side * 0.51, 1.085, -0.07);
      this.headRig.add(tuftRig);
      feather(tuftRig, FUR_SHADE, 'compact swept ear tuft',
        point(-side * 0.03, -0.04, -0.01), point(side * 0.13, 0.28, 0.045),
        0.084, 0.059);
    }

    // Smooth overlapping discs make one calm heart-shaped owl face.
    for (const side of [-1, 1] as const) {
      const outer = ellipsoid(this.headRig, DISC_RIM, 'russet facial-disc border',
        side * 0.305, 0.641, 0.475, 0.392, 0.430, 0.145, 36);
      outer.rotation.z = -side * 0.235;
      const inner = ellipsoid(this.headRig, DISC_CREAM, 'raised cream facial cheek',
        side * 0.300, 0.637, 0.562, 0.340, 0.400, 0.108, 40);
      inner.rotation.z = -side * 0.285;
    }

    for (const side of [-1, 1] as const) {
      const eye = side < 0 ? this.leftEye : this.rightEye;
      const iris = side < 0 ? this.leftIris : this.rightIris;
      eye.position.set(side * 0.315, 0.660, 0.655);
      eye.scale.set(0.88, 1, 1);
      this.headRig.add(eye);
      ellipsoid(eye, EYE_RIM, 'velvety oval eye socket', 0, 0, 0, 0.180, 0.220, 0.047, 36);
      ellipsoid(eye, IRIS_GOLD, 'warm iris outer ring', 0, 0, 0.035,
        0.153, 0.170, 0.031, 36);
      iris.position.z = 0.063;
      eye.add(iris);
      ellipsoid(iris, IRIS, 'amber owl iris', 0, 0, 0,
        0.128, 0.145, 0.022, 32);
      ellipsoid(iris, PUPIL, 'deep round pupil', 0, -0.003, 0.020,
        0.079, 0.094, 0.017, 30);
      ellipsoid(iris, EYE_GLINT, 'soft eye catchlight', -0.034, 0.053, 0.039,
        0.012, 0.016, 0.003, 14);
      ellipsoid(iris, EYE_GLINT, 'secondary small catchlight', 0.040, -0.036, 0.039,
        0.004, 0.005, 0.002, 10);

      const brow = side < 0 ? this.leftBrow : this.rightBrow;
      brow.position.set(side * 0.315, 0.935, 0.664);
      this.headRig.add(brow);
      feather(brow, FUR, 'soft expressive brow feather',
        point(-side * 0.13, -0.022, -0.018),
        point(side * 0.14, 0.014, -0.055), 0.026, 0.016);
    }

    // The triangular bill lifts a little at its root. A tapered opening sits
    // partly on its lower surface, so the gape remains connected to the gold
    // silhouette even during a broad yawn or a pitched-forward sneeze.
    this.mouthRig.position.set(0, 0.283, 0.836);
    this.headRig.add(this.mouthRig);
    const gapeOutline = new THREE.Shape();
    gapeOutline.moveTo(-0.033, 0.025);
    gapeOutline.quadraticCurveTo(0, 0.034, 0.033, 0.025);
    gapeOutline.bezierCurveTo(0.043, 0.002, 0.030, -0.019, 0.014, -0.026);
    gapeOutline.quadraticCurveTo(0, -0.031, -0.014, -0.026);
    gapeOutline.bezierCurveTo(-0.030, -0.019, -0.043, 0.002, -0.033, 0.025);
    const gape = mesh(this.mouthRig, new THREE.ShapeGeometry(gapeOutline, 18),
      MOUTH, 'tapered opening within beak');
    gape.castShadow = false;
    this.upperBeakRig.position.set(0, 0.482, 0.655);
    this.headRig.add(this.upperBeakRig);
    const upperBeak = mesh(this.upperBeakRig, loft([
      { x: 0, y: 0, z: 0, width: 0.056, depth: 0.061 },
      { x: 0, y: -0.061, z: 0.093, width: 0.085, depth: 0.082 },
      { x: 0, y: -0.145, z: 0.154, width: 0.046, depth: 0.055 },
      { x: 0, y: -0.205, z: 0.162, width: 0.004, depth: 0.008 },
    ], 24), BEAK, 'single hinged golden beak');
    upperBeak.userData.action = 'poke';
    upperBeak.castShadow = false;
    ellipsoid(this.upperBeakRig, BEAK_LIGHT, 'beak tip glimmer',
      -0.022, -0.061, 0.172, 0.017, 0.024, 0.004, 16);

    // Raycast clients may use either the hit mesh itself or a tagged parent.
    this.headRig.userData.action = 'poke';
    this.headRig.traverse(object => {
      if ((object as THREE.Mesh).isMesh && object.userData.action === undefined) object.userData.action = 'poke';
    });
  }

  private buildWing(side: -1 | 1): Wing {
    const shoulder = point(side * 0.45, 1.05, -0.03);
    const elbow = point(side * 0.70, 0.58, 0.39);
    const hand = point(side * 0.68, 0.24, 0.48);
    const surface = mesh(this.torsoRig, wingSurfaceGeometry(),
      WING_RUSSET, 'continuous folded russet owl wing');
    surface.userData.action = 'poke';
    bendWing(surface, side, shoulder, elbow, hand);
    const tip = new THREE.Group();
    tip.name = side < 0 ? 'left feather tip grip' : 'right feather tip grip';
    tip.userData.action = 'poke';
    this.torsoRig.add(tip);
    return { side, shoulder, elbow, hand, surface, tip };
  }

  private buildPaper(): void {
    this.paper.position.set(0, 1.02, 1.0);
    this.paper.rotation.x = -0.08;
    this.paper.userData.action = 'newspaper';
    this.torsoRig.add(this.paper);
    this.paper.add(this.leftPage, this.rightPage, this.loosePage);

    const printed = new THREE.MeshStandardMaterial({
      map: paperTexture(), color: 0xffffff, roughness: 0.93,
      side: THREE.DoubleSide,
    });
    const inner = new THREE.MeshStandardMaterial({
      color: 0xe6deca, roughness: 0.98, side: THREE.DoubleSide,
    });
    const middle = new THREE.MeshStandardMaterial({
      color: 0xd4c9b1, roughness: 0.98, side: THREE.DoubleSide,
    });
    const edge = new THREE.MeshStandardMaterial({ color: 0x9d927d, roughness: 0.95 });

    for (const side of [-1, 1] as const) {
      const leaf = side < 0 ? this.leftPage : this.rightPage;
      leaf.name = side < 0 ? 'Left newspaper leaf hinge' : 'Right newspaper leaf hinge';
      mesh(leaf, paperLeafGeometry(side, 2, 0.982), middle, 'lower paper sheet');
      mesh(leaf, paperLeafGeometry(side, 1, 0.991), inner, 'middle paper sheet');
      mesh(leaf, paperLeafGeometry(side), printed, 'printed newspaper leaf');
      const outerEdge = mesh(leaf, new THREE.BoxGeometry(0.012, 0.91, 0.043), inner, 'layered outer paper edge');
      outerEdge.position.set(side * 0.728, 0, 0.009);
      curve(leaf, [
        point(0, -0.464, 0.028), point(side * 0.32, -0.464, 0.042),
        point(side * 0.735, -0.464, 0.052),
      ], 0.005, edge, 'inked lower paper edge', 22);
    }
    curve(this.paper, [point(0, -0.465, 0.033), point(0, 0, 0.039), point(0, 0.465, 0.033)],
      0.009, edge, 'stitched newspaper spine', 18);

    // An unbound right leaf lifts in a small page turn while the owl reads.
    this.loosePage.position.z = 0.046;
    mesh(this.loosePage, paperLeafGeometry(1, 0, 0.972), printed, 'loose turning page');
    curve(this.loosePage, [point(0.01, 0.447, 0.03), point(0.35, 0.447, 0.044), point(0.71, 0.447, 0.053)],
      0.006, inner, 'curled loose page edge', 20);

    this.paperCorner.position.set(0.55, 0.30, 0.065);
    this.rightPage.add(this.paperCorner);
    mesh(this.paperCorner, foldedCornerGeometry(), inner, 'flipped upper newspaper corner');
    this.paper.traverse(object => {
      if ((object as THREE.Mesh).isMesh) object.userData.action = 'newspaper';
    });
  }

  private buildHandProps(): void {
    this.rightWing.tip.add(this.phone, this.biscuit, this.mug, this.flask);
    this.phone.visible = false;
    this.biscuit.visible = false;
    this.mug.visible = false;
    this.flask.visible = false;

    // A little antiquated receiver for the future Twilio interaction.
    this.phone.position.set(0.025, 0.035, 0.270);
    // The top cup meets the feathered side of the owl's head; the lower cup
    // points diagonally toward the beak.
    this.phone.rotation.z = -0.50;
    this.phone.rotation.y = -0.90;
    curve(this.phone, [point(0.015, -0.27, 0), point(-0.015, -0.09, -0.01), point(-0.015, 0.09, -0.01), point(0.015, 0.27, 0)], 0.064, PHONE_DARK, 'receiver-grip', 24);
    for (const y of [-0.30, 0.30]) {
      ellipsoid(this.phone, EAR_DARK, 'receiver-cup', 0.015, y, 0.01, 0.16, 0.10, 0.11, 22);
      ellipsoid(this.phone, BRASS, 'receiver-ring', 0.015, y, 0.113, 0.126, 0.079, 0.014, 20);
      ellipsoid(this.phone, PHONE_DARK, 'receiver-speaker', 0.015, y, 0.128, 0.093, 0.055, 0.008, 18);
      for (let i = -1; i <= 1; i++) {
        ellipsoid(this.phone, PHONE_DETAIL, 'speaker-perforation', i * 0.038 + 0.015, y, 0.137, 0.008, 0.009, 0.004, 8);
      }
    }
    // The cookie is the same scalloped oat biscuit that rises from the tin.
    // A second mesh reveals a real bite mark at mouth contact, with a few crumbs.
    this.biscuit.position.set(-0.08, 0.075, 0.19);
    this.biscuit.add(this.wholeBiscuit, this.bittenBiscuit, this.biscuitCrumbs);
    const oat = new THREE.MeshStandardMaterial({ color: 0xc58a50, roughness: 0.96 });
    const chocolate = new THREE.MeshStandardMaterial({ color: 0x50332b, roughness: 0.78 });
    const toasted = new THREE.MeshStandardMaterial({ color: 0xe6b475, roughness: 0.97 });
    const chips = [
      [-0.075, 0.080], [-0.030, -0.055], [0.045, 0.095],
      [0.092, -0.025], [0.120, 0.070], [0.005, 0.025],
      [-0.105, -0.012], [0.055, -0.108], [-0.030, 0.127],
    ] as const;
    for (const [group, bitten] of [[this.wholeBiscuit, false], [this.bittenBiscuit, true]] as const) {
      mesh(group, cookieCrustGeometry(bitten), oat,
        bitten ? 'biscuit with a bitten scallop' : 'whole scalloped oat biscuit');
      for (const [index, [x, y]] of chips.entries()) {
        if (bitten && x < -0.060 && Math.abs(y) < 0.100) continue;
        ellipsoid(group, chocolate, 'inset chocolate chip', x, y, 0.064,
          0.016 + index % 3 * 0.002, 0.013, 0.006, 12);
        ellipsoid(group, toasted, 'toasted oat fleck', x + 0.027, y - 0.017, 0.061,
          0.008, 0.006, 0.003, 10);
      }
    }
    for (let index = 0; index < 5; index++) {
      ellipsoid(this.biscuitCrumbs, index % 2 ? toasted : oat, 'falling cookie crumb',
        -0.13, 0.03, 0.09, 0.010 + index % 3 * 0.004, 0.008, 0.006, 8);
    }
    // Hollow hand-glazed ceramic matches the cup on the side table. The
    // wingtip feathers wrap around its D-handle.
    this.mug.position.set(-0.15, -0.080, 0.18);
    const ceramic = new THREE.MeshPhysicalMaterial({
      color: 0xf1e5ce, roughness: 0.22, metalness: 0.025,
      clearcoat: 0.38, clearcoatRoughness: 0.18,
    });
    const glaze = new THREE.MeshStandardMaterial({ color: 0x376d70, roughness: 0.31 });
    const tea = new THREE.MeshPhysicalMaterial({
      color: 0x6d3d27, roughness: 0.16, metalness: 0.04,
      clearcoat: 0.70, clearcoatRoughness: 0.10,
    });
    const cupProfile = [
      [0, 0.018], [0.072, 0.018], [0.092, 0.028], [0.109, 0.052],
      [0.121, 0.118], [0.133, 0.221], [0.128, 0.241], [0.117, 0.243],
      [0.111, 0.223], [0.105, 0.146], [0.093, 0.066], [0.069, 0.051], [0, 0.051],
    ].map(([radius, height]) => new THREE.Vector2(radius!, height!));
    mesh(this.mug, new THREE.LatheGeometry(cupProfile, 36), ceramic, 'hollow glazed mug');
    mesh(this.mug, new THREE.LatheGeometry([
      new THREE.Vector2(0.119, 0.101), new THREE.Vector2(0.124, 0.105),
      new THREE.Vector2(0.126, 0.133), new THREE.Vector2(0.123, 0.137),
    ], 36), glaze, 'broad teal hand-painted mug band');
    for (const [radius, height, material] of [
      [0.121, 0.238, BRASS], [0.114, 0.081, glaze], [0.108, 0.061, glaze],
    ] as const) {
      const band = mesh(this.mug, new THREE.TorusGeometry(radius, 0.006, 8, 32), material,
        'rolled mug rim and glaze band');
      band.rotation.x = Math.PI / 2;
      band.position.y = height;
    }
    curve(this.mug, [
      point(0.119, 0.191, 0), point(0.205, 0.211, 0),
      point(0.268, 0.172, 0), point(0.273, 0.117, 0),
      point(0.228, 0.062, 0), point(0.119, 0.072, 0),
    ], 0.024, ceramic, 'mug D-handle', 24);
    ellipsoid(this.mug, glaze, 'teal ceramic crest', 0, 0.170, 0.127,
      0.035, 0.040, 0.005, 14);
    this.mugTeaSurface.position.y = 0.192;
    this.mug.add(this.mugTeaSurface);
    const teaFace = mesh(this.mugTeaSurface, new THREE.CircleGeometry(0.105, 32), tea, 'amber tea surface');
    teaFace.rotation.x = -Math.PI / 2;
    ellipsoid(this.mugTeaSurface, toasted, 'tea highlight', -0.038, 0.002, 0.024,
      0.038, 0.002, 0.012, 12);
    this.flask.position.set(0, 0.21, 0.17);
    const glass = new THREE.MeshPhysicalMaterial({ color: 0xd8efea, metalness: 0.04, roughness: 0.13, transmission: 0.35, transparent: true, opacity: 0.76, depthWrite: false, side: THREE.DoubleSide });
    mesh(this.flask, new THREE.CylinderGeometry(0.055, 0.14, 0.29, 16), glass, 'lab-flask');
    ellipsoid(this.flask, new THREE.MeshStandardMaterial({ color: 0x55bbb2, emissive: 0x13756d, emissiveIntensity: 0.4, roughness: 0.35 }), 'potion', 0, -0.075, 0, 0.119, 0.068, 0.119, 20);
    mesh(this.flask, new THREE.CylinderGeometry(0.061, 0.061, 0.065, 16), BRASS, 'flask-stopper').position.y = 0.177;
  }

  /** x and y are normalized to roughly [-1, 1]. */
  setLook(x: number, y: number): void {
    this.lookTarget.set(clamp(x, -1, 1), clamp(y, -1, 1));
  }

  /** True only after the page is stowed and the visible receiver reaches his ear. */
  isCallPickupReady(): boolean {
    return !this.disposed
      && this.paperTarget === 0
      && this.paperMotion === 0
      && !this.paper.visible
      && this.callHeld
      && this.phone.visible
      && this.action !== 'hangup'
      && this.rightWing.hand.distanceToSquared(this.phoneGripTarget) < 0.014;
  }

  /** Used to hand the desk receiver to Talking Owl on its first visible lift frame. */
  isPhonePickupStarted(): boolean {
    return !this.disposed && this.paperMotion === 0 && this.callHeld && this.phone.visible;
  }

  /** Null while the newspaper still holds a queued snack or drink action. */
  getActionAge(action: 'eat' | 'sip'): number | null {
    return !this.disposed && this.action === action ? this.actionAge : null;
  }

  /** Start a short gesture or enter a sustained call listening pose. */
  trigger(action: string): void {
    const valid: ActionName[] = [
      'newspaper', 'poke', 'tickle', 'eat', 'sip', 'burp', 'call', 'listen',
      'talk', 'hangup', 'yes', 'no', 'laugh', 'mix', 'surprise',
      'wave', 'ponder', 'gasp', 'dance', 'snooze', 'sing',
      'wink', 'shrug', 'salute', 'scratch', 'yawn', 'hush', 'cheer',
      'shiver', 'bow', 'sneeze',
    ];
    if (!valid.includes(action as ActionName)) return;
    if (this.pendingAction === 'call' && this.paperMotion > 0) {
      // A wall-clock UI callback can arrive before enough animation frames have
      // passed to finish the fold. Keep the pending pickup instead of letting a
      // premature listen or other reaction silently replace it.
      if (action === 'hangup') {
        this.pendingAction = null;
        this.paperTarget = 0;
        this.action = 'newspaper';
        this.actionAge = 0;
        return;
      }
      if (action !== 'call') return;
    }
    if (this.action === 'call' && !this.isCallPickupReady()
      && action !== 'call' && action !== 'hangup') return;
    if (action === 'newspaper') {
      this.paperTarget = this.callHeld ? 0 : this.paperTarget === 1 ? 0 : 1;
      this.pendingAction = null;
      this.action = 'newspaper';
      this.actionAge = 0;
      return;
    }
    // Main may request the next reaction on the very same click that interrupts
    // reading. Hold it until both leaves have folded and the tips have released.
    if (this.paperMotion > 0 || this.paperTarget === 1) {
      this.paperTarget = 0;
      this.pendingAction = action as ActionName;
      this.action = 'newspaper';
      this.actionAge = 0;
      return;
    }
    this.beginAction(action as ActionName);
  }

  private beginAction(action: ActionName): void {
    if (action === 'call' || action === 'listen' || action === 'talk') this.callHeld = true;
    if (action === 'hangup') this.callHeld = false;
    this.action = action as ActionName;
    this.actionAge = 0;
  }

  private advancePaper(dt: number): void {
    if (this.paperTarget === 1) this.paperMotion = Math.min(1, this.paperMotion + dt / 1.34);
    else this.paperMotion = Math.max(0, this.paperMotion - dt / 1.16);
    if (this.paperMotion === 0 && this.pendingAction) {
      const next = this.pendingAction;
      this.pendingAction = null;
      this.beginAction(next);
    }
  }

  private posePaper(now: number): void {
    const motion = this.paperMotion;
    const emerge = smoothStep((motion - 0.05) / 0.21);
    const lift = smoothStep((motion - 0.25) / 0.63);
    const unfold = smoothStep((motion - 0.52) / 0.36);
    const reading = smoothStep((motion - 0.82) / 0.17);
    const turnPhase = (now + 1.3) % 6.8;
    const turn = turnPhase > 4.72 && turnPhase < 5.95
      ? bell((turnPhase - 4.72) / 1.23) * reading : 0;
    const hinge = THREE.MathUtils.lerp(0.97, 0.16, unfold);

    // The hands arrive at the lap before the folded sheet emerges, and remain
    // on its edge until it has been tucked away on the reverse trip.
    this.paper.visible = motion > 0.14;
    // Keep the top edge below the lowest position of his nose, including the
    // backward sweep of the loose page and the forward pitch of his reading pose.
    this.paper.position.set(0, 0.04 + emerge * 0.32 + lift * 0.39,
      0.12 + emerge * 0.56 + lift * 0.45);
    this.paper.rotation.x = -0.44 + lift * 0.36;
    this.paper.rotation.y = Math.sin(now * 0.47) * 0.012 * reading;
    this.paper.rotation.z = Math.sin(now * 0.79) * 0.007 * reading;
    this.leftPage.rotation.y = hinge + Math.sin(now * 8.3) * 0.010 * reading;
    this.rightPage.rotation.y = -hinge - Math.sin(now * 7.7) * 0.018 * reading - turn * 0.045;
    this.loosePage.rotation.y = -hinge - turn * 1.12;
    this.paperCorner.quaternion.setFromAxisAngle(PAPER_CORNER_AXIS, turn * 0.72);
  }

  update(dt: number, elapsed: number): void {
    const delta = clamp(Number.isFinite(dt) ? dt : 0, 0, 0.2);
    this.elapsedInternal += delta;
    const now = Number.isFinite(elapsed) ? elapsed : this.elapsedInternal;
    this.advancePaper(delta);
    this.actionAge += delta;
    const duration: Partial<Record<ActionName, number>> = {
      newspaper: 0.95, poke: 0.8, tickle: 1.5, eat: EAT_DURATION, sip: SIP_DURATION,
      burp: 1.25, call: 1.0, talk: 2.4, hangup: 1.2, yes: 0.9,
      no: 0.95, laugh: 1.65, mix: 1.7, surprise: 1.25,
      wave: 1.7, ponder: 2.0, gasp: 1.25, dance: 2.35,
      snooze: 2.35, sing: 2.4,
      wink: 1.35, shrug: 1.8, salute: 1.55, scratch: 1.85,
      yawn: 2.25, hush: 1.65, cheer: 2.0, shiver: 1.75,
      bow: 1.95, sneeze: 1.55,
    };
    const limit = duration[this.action];
    if (limit !== undefined && this.actionAge > limit) {
      this.action = this.callHeld ? 'listen' : 'idle';
      this.actionAge = 0;
    }

    const progress = clamp(this.actionAge / (duration[this.action] ?? 1), 0, 1);
    const pulse = bell(progress);
    const time = this.actionAge;
    const breath = Math.sin(now * 2.25);
    const readWeight = smoothStep((this.paperMotion - 0.73) / 0.25);
    let headX = -0.025 + breath * 0.012;
    let headY = Math.sin(now * 0.7) * 0.018;
    let headZ = Math.sin(now * 0.43) * 0.025;
    let torsoX = breath * 0.006;
    let torsoZ = Math.sin(now * 0.55) * 0.008;
    let bodyLift = breath * 0.004;
    let headBob = 0;
    let mouthOpen = 0.075;
    let eyeOpen = 1.0;
    let browLift = 0;
    let browAsym = 0;
    let earKick = 0;
    let leftEarScritch = 0;
    let leftWink = 0;
    let tailWag = 0.055 * Math.sin(now * 2.0);

    headX += readWeight * 0.12;
    headZ -= readWeight * 0.025;
    torsoX += readWeight * 0.012;
    eyeOpen = THREE.MathUtils.lerp(eyeOpen, 0.90, readWeight);

    switch (this.action) {
      case 'poke':
        headX += holdEnvelope(time, 0.23, 0.07, 0.12) * 0.045 - pulse * 0.25;
        headZ += pulse * 0.19;
        torsoZ -= pulse * 0.06;
        eyeOpen -= pulse * 0.47;
        browLift += pulse * 0.065;
        earKick = bell(clamp((time - 0.055) / 0.75, 0, 1)) * 0.18;
        mouthOpen += pulse * 0.13;
        break;
      case 'tickle':
        headZ += Math.sin(time * 15) * pulse * 0.09;
        torsoZ += Math.sin(time * 14) * pulse * 0.06;
        bodyLift += Math.sin(time * 13) * pulse * 0.022;
        mouthOpen = 0.075 + pulse * 0.72;
        eyeOpen -= pulse * 0.37;
        // Fan the visible tail feathers above the armrest during a laugh.
        tailWag = 0.08 + pulse * (0.26 + Math.sin(time * 9.5) * 0.22);
        break;
      case 'eat':
        {
          const reach = holdEnvelope(time - 0.08, 0.60, 0.18, 0.24);
          const present = holdEnvelope(time - 0.58, 0.51, 0.24, 0.17);
          const bite = holdEnvelope(time - 1.00, 0.35, 0.10, 0.11);
          const chew = holdEnvelope(time - 1.30, 0.66, 0.11, 0.17);
          const swallow = holdEnvelope(time - 1.87, 0.34, 0.12, 0.15);
          headY += reach * 0.12;
          torsoZ -= reach * 0.055;
          headX += present * 0.09 + bite * 0.12 - swallow * 0.065;
          headBob += chew * Math.sin(time * 13) * 0.010 - swallow * 0.012;
          mouthOpen = 0.075 + bite * 0.63
            + chew * (0.12 + Math.abs(Math.sin(time * 18)) * 0.20);
          eyeOpen -= bite * 0.09 + chew * 0.17 + swallow * 0.12;
          browLift += bite * 0.020;
          tailWag += chew * Math.sin(time * 7.5) * 0.065;
        }
        break;
      case 'sip':
        {
          const reach = holdEnvelope(time - 0.08, 0.60, 0.18, 0.24);
          const taste = holdEnvelope(time - 0.94, 0.78, 0.17, 0.19);
          const swallow = holdEnvelope(time - 1.68, 0.34, 0.12, 0.14);
          headY += reach * 0.12;
          torsoZ -= reach * 0.055;
          headX += taste * 0.095 - swallow * 0.085;
          headBob -= swallow * 0.022;
          mouthOpen = 0.075 + taste * 0.20 + swallow * 0.08;
          eyeOpen -= taste * 0.22 + swallow * 0.11;
          browLift += swallow * 0.025;
        }
        break;
      case 'burp':
        headX -= pulse * 0.30;
        torsoX -= pulse * 0.10;
        bodyLift += pulse * 0.031;
        mouthOpen = 0.09 + pulse * 0.87;
        browLift = pulse * 0.08;
        earKick = pulse * 0.21;
        break;
      case 'call':
        headZ += pulse * 0.06;
        browLift = pulse * 0.035;
        headBob += pulse * 0.015;
        break;
      case 'listen':
        headZ += 0.095 + Math.sin(now * 0.8) * 0.018;
        eyeOpen = 1.0;
        browLift = 0.025;
        break;
      case 'talk':
        headZ += 0.07;
        headX += Math.sin(time * 5.5) * 0.025;
        mouthOpen = 0.12 + holdEnvelope(time, 2.4, 0.15, 0.24)
          * (0.15 + 0.50 * Math.abs(Math.sin(time * 12.5)));
        browLift = 0.04;
        break;
      case 'hangup':
        headY -= pulse * 0.10;
        mouthOpen += pulse * 0.09;
        break;
      case 'yes':
        headX += Math.sin(time * 17) * pulse * 0.21;
        mouthOpen += pulse * 0.10;
        break;
      case 'no':
        headY += Math.sin(time * 16) * pulse * 0.25;
        mouthOpen += pulse * 0.08;
        break;
      case 'laugh':
        headX -= pulse * 0.17;
        torsoX -= pulse * 0.06;
        torsoZ += Math.sin(time * 12) * pulse * 0.035;
        bodyLift += Math.max(0, Math.sin(time * 12)) * pulse * 0.026;
        mouthOpen = 0.075 + pulse * 0.84;
        eyeOpen -= pulse * 0.43;
        tailWag += Math.sin(time * 13.5) * pulse * 0.48;
        break;
      case 'mix':
        headX += pulse * 0.22;
        headZ -= pulse * 0.06;
        browLift = pulse * 0.05;
        tailWag += Math.sin(time * 8) * pulse * 0.1;
        break;
      case 'surprise':
        headX -= pulse * 0.25;
        torsoX -= pulse * 0.13;
        bodyLift += pulse * 0.032;
        headZ += pulse * 0.08;
        eyeOpen += pulse * 0.21;
        browLift = pulse * 0.13;
        mouthOpen = 0.075 + pulse * 0.84;
        earKick = pulse * 0.25;
        break;
      case 'wave':
        headZ += Math.sin(time * 8) * pulse * 0.07;
        mouthOpen = 0.075 + pulse * 0.33;
        browLift = pulse * 0.055;
        tailWag += Math.sin(time * 11) * pulse * 0.25;
        break;
      case 'ponder':
        headX += pulse * 0.12;
        headZ -= pulse * 0.15;
        browLift = pulse * 0.045;
        browAsym = pulse * 0.08;
        mouthOpen = 0.065;
        break;
      case 'gasp':
        headX += holdEnvelope(time, 0.25, 0.07, 0.13) * 0.06 - pulse * 0.27;
        torsoX -= pulse * 0.12;
        bodyLift += pulse * 0.029;
        eyeOpen += pulse * 0.27;
        browLift = pulse * 0.12;
        mouthOpen = 0.075 + pulse * 0.94;
        earKick = pulse * 0.23;
        break;
      case 'dance':
        torsoZ += Math.sin(time * 8.5) * pulse * 0.16;
        headZ -= Math.sin(time * 8.5) * pulse * 0.14;
        headY += Math.sin(time * 4.3) * pulse * 0.08;
        bodyLift += Math.max(0, Math.sin(time * 8.5)) * pulse * 0.034;
        mouthOpen = 0.075 + pulse * (0.26 + Math.abs(Math.sin(time * 8)) * 0.18);
        tailWag += Math.sin(time * 14.5) * pulse * 0.50;
        break;
      case 'snooze':
        headX += pulse * 0.34;
        headZ += pulse * 0.14;
        eyeOpen -= pulse * 0.80;
        mouthOpen = 0.06;
        headBob -= pulse * 0.036;
        break;
      case 'sing':
        headZ += Math.sin(time * 5.2) * pulse * 0.10;
        headX -= pulse * 0.07;
        mouthOpen = 0.075 + pulse * (0.22 + Math.abs(Math.sin(time * 10)) * 0.62);
        browLift = pulse * 0.065;
        earKick = Math.sin(time * 10) * pulse * 0.035;
        tailWag += Math.sin(time * 9.5) * pulse * 0.18;
        break;
      case 'wink':
        headZ += pulse * 0.18;
        headY -= pulse * 0.055;
        leftWink = holdEnvelope(time, 1.35, 0.25, 0.34) * 0.96;
        browAsym = pulse * 0.08;
        mouthOpen = 0.08 + pulse * 0.21;
        tailWag += Math.sin(time * 9) * pulse * 0.13;
        break;
      case 'shrug':
        bodyLift += pulse * 0.045;
        torsoZ -= pulse * 0.065;
        headZ += pulse * 0.16;
        eyeOpen += pulse * 0.11;
        browLift += pulse * 0.13;
        mouthOpen = 0.10 + pulse * 0.12;
        break;
      case 'salute':
        headX -= pulse * 0.10;
        headZ -= pulse * 0.065;
        browLift += pulse * 0.075;
        mouthOpen = 0.08 + pulse * 0.18;
        tailWag += Math.sin(time * 8) * pulse * 0.14;
        break;
      case 'scratch':
        headZ += pulse * 0.17;
        headY -= pulse * 0.065;
        leftEarScritch = Math.sin(time * 20) * pulse * 0.13;
        eyeOpen -= pulse * 0.23;
        mouthOpen = 0.075 + pulse * 0.12;
        break;
      case 'yawn':
        headX -= pulse * 0.26;
        torsoX -= pulse * 0.055;
        eyeOpen -= pulse * 0.60;
        mouthOpen = 0.075 + pulse * 0.86;
        browLift += pulse * 0.045;
        earKick -= pulse * 0.055;
        break;
      case 'hush':
        headX += pulse * 0.13;
        headZ -= pulse * 0.10;
        eyeOpen -= pulse * 0.25;
        browAsym += pulse * 0.05;
        mouthOpen = 0.035;
        tailWag *= 0.25;
        break;
      case 'cheer':
        headX -= pulse * 0.16;
        torsoZ += Math.sin(time * 9) * pulse * 0.065;
        bodyLift += Math.max(0, Math.sin(time * 10)) * pulse * 0.052;
        mouthOpen = 0.075 + pulse * 0.74;
        eyeOpen -= pulse * 0.12;
        browLift += pulse * 0.07;
        earKick += pulse * 0.18;
        tailWag += Math.sin(time * 15) * pulse * 0.53;
        break;
      case 'shiver':
        torsoZ += Math.sin(time * 25) * pulse * 0.055;
        headZ -= Math.sin(time * 25) * pulse * 0.07;
        bodyLift += Math.abs(Math.sin(time * 22)) * pulse * 0.017;
        eyeOpen -= pulse * 0.21;
        mouthOpen = 0.075 + pulse * (0.06 + Math.abs(Math.sin(time * 23)) * 0.12);
        earKick -= pulse * 0.075;
        break;
      case 'bow':
        torsoX += pulse * 0.19;
        headX += pulse * 0.46;
        headBob -= pulse * 0.067;
        eyeOpen -= pulse * 0.32;
        mouthOpen = 0.07;
        tailWag += Math.sin(time * 5) * pulse * 0.08;
        break;
      case 'sneeze':
        {
          const sniff = holdEnvelope(time, 0.56, 0.11, 0.16);
          const burst = holdEnvelope(time - 0.53, 0.68, 0.07, 0.32);
          headX += sniff * 0.12 + burst * 0.47;
          torsoX += burst * 0.19;
          bodyLift += burst * 0.037;
          headZ += burst * 0.10;
          eyeOpen -= sniff * 0.14 + burst * 0.72;
          mouthOpen = 0.075 + burst * 0.85;
          earKick += burst * 0.31;
          tailWag += Math.sin(time * 17) * burst * 0.26;
        }
        break;
      case 'newspaper':
      case 'idle':
        break;
    }

    this.torsoRig.position.y = damp(this.torsoRig.position.y, 0.9 + bodyLift, delta, 7);
    this.torsoRig.rotation.x = damp(this.torsoRig.rotation.x, torsoX, delta, 8);
    this.torsoRig.rotation.z = damp(this.torsoRig.rotation.z, torsoZ, delta, 8);
    this.torsoRig.scale.y = damp(this.torsoRig.scale.y, 1 + breath * 0.008, delta, 5);
    this.headRig.position.y = damp(this.headRig.position.y, 1.055 + headBob, delta, 8);
    this.headRig.rotation.x = damp(this.headRig.rotation.x, headX, delta, 11);
    this.headRig.rotation.y = damp(this.headRig.rotation.y, headY, delta, 10);
    this.headRig.rotation.z = damp(this.headRig.rotation.z, headZ, delta, 11);
    const headSpeedX = clamp((this.headRig.rotation.x - this.lastHeadX) / Math.max(delta, 0.004), -2.4, 2.4);
    const headSpeedZ = clamp((this.headRig.rotation.z - this.lastHeadZ) / Math.max(delta, 0.004), -2.4, 2.4);
    this.lastHeadX = this.headRig.rotation.x;
    this.lastHeadZ = this.headRig.rotation.z;
    this.leftEar.rotation.x = damp(this.leftEar.rotation.x, -headSpeedX * 0.035, delta, 7);
    this.rightEar.rotation.x = damp(this.rightEar.rotation.x, -headSpeedX * 0.029, delta, 7);
    this.leftEar.rotation.z = damp(this.leftEar.rotation.z,
      -0.045 + Math.sin(now * 1.4) * 0.018 - earKick + leftEarScritch - headSpeedZ * 0.065, delta, 7);
    this.rightEar.rotation.z = damp(this.rightEar.rotation.z,
      0.035 + Math.sin(now * 1.7) * 0.022 + earKick * 0.75 - headSpeedZ * 0.055, delta, 7);
    const tailReveal = this.action === 'tickle'
      ? holdEnvelope(time, 1.5, 0.13, 0.28)
      : this.action === 'laugh' ? holdEnvelope(time, 1.65, 0.16, 0.30) : 0;
    this.tailRig.position.x = damp(this.tailRig.position.x,
      THREE.MathUtils.lerp(0.11, 0.64, tailReveal), delta, 12);
    this.tailRig.position.y = damp(this.tailRig.position.y,
      THREE.MathUtils.lerp(0.93, 1.02, tailReveal), delta, 12);
    this.tailRig.position.z = damp(this.tailRig.position.z,
      THREE.MathUtils.lerp(-0.39, 0.03, tailReveal), delta, 12);
    this.tailRig.scale.x = damp(this.tailRig.scale.x,
      THREE.MathUtils.lerp(0.53, 0.92, tailReveal), delta, 12);
    this.tailRig.scale.y = damp(this.tailRig.scale.y,
      THREE.MathUtils.lerp(0.56, 0.90, tailReveal), delta, 12);
    this.tailRig.rotation.y = damp(this.tailRig.rotation.y,
      tailWag * 0.34, delta, 14);
    this.tailRig.rotation.z = damp(this.tailRig.rotation.z,
      0.20 * tailReveal + tailWag + torsoZ * 0.28, delta, 13);
    this.tailRig.rotation.x = damp(this.tailRig.rotation.x, Math.sin(now * 2.2) * 0.015, delta, 5);

    // A short double blink at irregular-looking offsets, even in quiet idle.
    const blinkPhase = now % 5.9;
    const blinkAt = (center: number): number => clamp(1 - Math.abs(blinkPhase - center) / 0.11, 0, 1);
    const blink = Math.max(blinkAt(0.51), blinkAt(3.72), blinkAt(3.94) * 0.8);
    const eyeY = clamp(eyeOpen * (1 - blink * 0.94), 0.045, 1.25);
    this.leftEye.scale.y = damp(this.leftEye.scale.y, eyeY * (1 - leftWink * 0.94), delta, 31);
    this.rightEye.scale.y = damp(this.rightEye.scale.y, eyeY, delta, 31);
    this.leftBrow.position.y = damp(this.leftBrow.position.y, 0.935 + browLift + browAsym, delta, 12);
    this.rightBrow.position.y = damp(this.rightBrow.position.y, 0.935 + browLift * 0.83 - browAsym * 0.4, delta, 12);
    this.leftBrow.rotation.z = damp(this.leftBrow.rotation.z, 0.03 - browLift * 0.55, delta, 12);
    this.rightBrow.rotation.z = damp(this.rightBrow.rotation.z, -0.03 + browLift * 0.35, delta, 12);

    const readCycle = now % 4.65;
    const lineScan = readCycle < 3.65
      ? THREE.MathUtils.lerp(-0.32, 0.32, smoothStep(readCycle / 3.65))
      : THREE.MathUtils.lerp(0.32, -0.32, smoothStep((readCycle - 3.65) / 1));
    const gazeX = THREE.MathUtils.lerp(
      this.action === 'ponder' ? -0.56 * pulse : this.lookTarget.x,
      lineScan, readWeight,
    );
    const gazeY = THREE.MathUtils.lerp(
      this.action === 'ponder' ? 0.48 * pulse
        : this.action === 'snooze' ? -0.35 * pulse : this.lookTarget.y,
      -0.38 - 0.035 * Math.sin(now * 1.45), readWeight,
    );
    this.lookCurrent.x = damp(this.lookCurrent.x, gazeX, delta, 7);
    this.lookCurrent.y = damp(this.lookCurrent.y, gazeY, delta, 7);
    for (const iris of [this.leftIris, this.rightIris]) {
      iris.position.x = this.lookCurrent.x * 0.039;
      iris.position.y = this.lookCurrent.y * 0.034;
    }
    const beakOpening = smoothStep((mouthOpen - 0.12) / 0.80);
    this.mouthRig.visible = beakOpening > 0.015;
    this.mouthRig.scale.y = damp(this.mouthRig.scale.y,
      0.35 + beakOpening * (this.action === 'yawn' ? 1.83 : 0.92), delta, 18);
    this.mouthRig.scale.x = damp(this.mouthRig.scale.x,
      0.42 + beakOpening * (this.action === 'yawn' ? 0.78 : 0.58), delta, 18);
    this.upperBeakRig.rotation.x = damp(this.upperBeakRig.rotation.x,
      -beakOpening * (this.action === 'yawn' ? 0.11 : 0.075), delta, 14);

    this.posePaper(now);

    this.updateWings(delta, now, pulse);
    this.phone.visible = (this.callHeld && (this.action !== 'call' || this.actionAge > 0.08))
      || (this.action === 'hangup' && this.actionAge < 0.99);
    this.biscuit.visible = !this.callHeld && this.action === 'eat'
      && this.actionAge >= 0.35 && this.actionAge < 2.50;
    this.mug.visible = !this.callHeld && this.action === 'sip'
      && this.actionAge >= 0.35 && this.actionAge < 2.30;
    this.flask.visible = !this.callHeld && this.action === 'mix';
    // The table handoff uses the prop's short glide into the feathered grip;
    // the owl's wing no longer stretches all the way to the tabletop.
    const biscuitTransfer = this.action === 'eat' ? Math.max(
      1 - smoothStep((this.actionAge - 0.35) / 0.35),
      smoothStep((this.actionAge - 2.12) / 0.37),
    ) : 0;
    const mugTransfer = this.action === 'sip' ? Math.max(
      1 - smoothStep((this.actionAge - 0.35) / 0.35),
      smoothStep((this.actionAge - 1.94) / 0.35),
    ) : 0;
    this.biscuit.position.x = -0.08 + biscuitTransfer * 0.33;
    this.mug.position.x = -0.15 + mugTransfer * 0.40;
    this.wholeBiscuit.visible = this.actionAge < 1.21;
    this.bittenBiscuit.visible = this.actionAge >= 1.21;
    const crumbTime = this.actionAge - 1.20;
    this.biscuitCrumbs.visible = this.biscuit.visible && crumbTime >= 0 && crumbTime < 0.42;
    this.biscuitCrumbs.children.forEach((object, index) => {
      const drift = Math.max(0, crumbTime);
      object.position.set(-0.13 - index * 0.014 - drift * (0.10 + index * 0.024),
        0.025 + index * 0.012 - drift * drift * (0.44 + index * 0.10),
        0.085 + index * 0.006 + drift * 0.11);
    });
    this.biscuit.rotation.z = damp(this.biscuit.rotation.z,
      this.action === 'eat' ? -0.05 + holdEnvelope(this.actionAge - 0.94, 0.54, 0.18, 0.19) * 0.11 : 0,
      delta, 12);
    const cupTip = this.action === 'sip' ? holdEnvelope(this.actionAge - 0.98, 0.76, 0.18, 0.19) : 0;
    this.mug.rotation.z = damp(this.mug.rotation.z, 0.43 * cupTip, delta, 13);
    this.mug.rotation.x = damp(this.mug.rotation.x, 0.12 + 0.20 * cupTip, delta, 13);
    this.mugTeaSurface.rotation.z = damp(this.mugTeaSurface.rotation.z,
      -this.mug.rotation.z * 0.62 + Math.sin(now * 8) * cupTip * 0.025, delta, 10);
    this.flask.rotation.z = this.action === 'mix' ? Math.sin(time * 9) * 0.17 * pulse : 0;
  }

  private updateWings(dt: number, now: number, pulse: number): void {
    const leftElbow = point(-0.70, 0.58, 0.39);
    const rightElbow = point(0.70, 0.58, 0.39);
    const leftHand = point(-0.68, 0.24, 0.48);
    const rightHand = point(0.68, 0.24, 0.48);
    const paperGrip = smoothStep((this.paperMotion - 0.015) / 0.145);
    const gripAt = (side: -1 | 1): THREE.Vector3 => {
      const leaf = side < 0 ? this.leftPage : this.rightPage;
      return point(side * 0.72, -0.445, 0.075)
        .applyEuler(leaf.rotation)
        .applyEuler(this.paper.rotation)
        .add(this.paper.position);
    };
    const leftGrip = gripAt(-1);
    const rightGrip = gripAt(1);
    const elbowAt = (side: -1 | 1, hand: THREE.Vector3): THREE.Vector3 =>
      point(side * Math.max(0.61, Math.abs(hand.x) + 0.14),
        0.48 + hand.y * 0.36, 0.35 + Math.max(0, hand.z - 0.70) * 0.19);
    leftElbow.lerp(elbowAt(-1, leftGrip), paperGrip);
    rightElbow.lerp(elbowAt(1, rightGrip), paperGrip);
    leftHand.lerp(leftGrip, paperGrip);
    rightHand.lerp(rightGrip, paperGrip);
    let leftGestures = false;
    let rightGestures = false;

    const phonePose = this.callHeld || this.action === 'hangup';
    if (phonePose) {
      // Follow the feathered side of the head through head and torso motion.
      // A forward pitch needs a little extra lift to keep the upper cup aligned.
      this.headRig.updateMatrix();
      const earAnchor = point(0.77, 0.85, 0.16).applyMatrix4(this.headRig.matrix);
      this.phoneGripTarget.copy(PHONE_EAR_HAND).add(earAnchor.sub(point(0.77, 1.905, 0.175)));
      this.phoneGripTarget.y += Math.max(0, this.headRig.rotation.x) * 0.40
        + Math.max(0, this.torsoRig.rotation.x) * 0.28;
      const phoneRise = this.action === 'call' ? smoothStep(this.actionAge / 0.68)
        : this.action === 'hangup' ? 1 - smoothStep(this.actionAge / 0.88) : 1;
      rightElbow.lerp(point(0.79, 1.24, 0.40), phoneRise);
      rightHand.lerp(this.phoneGripTarget, phoneRise);
      rightGestures = true;
    } else if (this.action === 'eat' || this.action === 'sip') {
      // Reach past the armrest, meet the table copy at the pickup frame, bring
      // the prop to the beak, pause for bite/sip, then return it to the table.
      rightElbow.copy(stagedPoint(this.actionAge,
        this.action === 'eat' ? EAT_ELBOW_PATH : SIP_ELBOW_PATH));
      rightHand.copy(stagedPoint(this.actionAge,
        this.action === 'eat' ? EAT_HAND_PATH : SIP_HAND_PATH));
      // The side table falls outside the narrow portrait view. Stage its
      // pickup just inside the visible edge there so the prop stays on screen.
      const portrait = typeof window !== 'undefined'
        ? clamp((560 - window.innerWidth) / 170, 0, 1) : 0;
      const pickup = holdEnvelope(this.actionAge - 0.10, 0.50, 0.19, 0.15);
      rightHand.x -= portrait * pickup * 0.32;
      rightElbow.x -= portrait * pickup * 0.15;
      rightGestures = true;
    } else if (this.action === 'mix') {
      const mix = holdEnvelope(this.actionAge, 1.7, 0.22, 0.33);
      rightElbow.lerp(point(0.73, 0.43, 0.59), mix);
      rightHand.lerp(point(0.34 + Math.sin(this.actionAge * 10) * mix * 0.09,
        0.48 + Math.sin(this.actionAge * 12) * mix * 0.08, 1.01), mix);
      rightGestures = true;
    } else if (this.action === 'surprise') {
      const lift = holdEnvelope(this.actionAge, 1.25, 0.17, 0.29);
      rightElbow.lerp(point(0.79, 1.19, 0.48), lift);
      rightHand.lerp(point(0.95, 1.48, 0.73), lift);
      rightGestures = true;
    } else if (this.action === 'poke') {
      rightHand.y += pulse * 0.27;
      rightHand.x -= pulse * 0.15;
      rightGestures = true;
    }

    switch (this.action) {
      case 'mix':
        leftElbow.lerp(point(-0.61, 0.43, 0.52), holdEnvelope(this.actionAge, 1.7, 0.22, 0.33));
        leftHand.lerp(point(-0.25, 0.28, 0.95), holdEnvelope(this.actionAge, 1.7, 0.22, 0.33));
        leftGestures = true;
        break;
      case 'surprise':
      case 'gasp':
        leftElbow.lerp(point(-0.74, 1.20, 0.53), holdEnvelope(this.actionAge, 1.25, 0.16, 0.27));
        leftHand.lerp(point(-0.62, 1.47, 0.89), holdEnvelope(this.actionAge, 1.25, 0.16, 0.27));
        leftGestures = true;
        break;
      case 'wave':
        {
          const wave = holdEnvelope(this.actionAge, 1.7, 0.25, 0.34);
          leftElbow.lerp(point(-0.80, 1.29, 0.45), wave);
          leftHand.lerp(point(-1.04 + Math.sin(this.actionAge * 13) * wave * 0.15,
            1.66 + Math.cos(this.actionAge * 13) * wave * 0.06, 0.76), wave);
        }
        leftGestures = true;
        break;
      case 'ponder':
        leftElbow.lerp(point(-0.67, 1.00, 0.60), holdEnvelope(this.actionAge, 2.0, 0.32, 0.36));
        leftHand.lerp(point(-0.40, 1.19, 0.95), holdEnvelope(this.actionAge, 2.0, 0.32, 0.36));
        leftGestures = true;
        break;
      case 'dance':
        {
          const dance = holdEnvelope(this.actionAge, 2.35, 0.27, 0.36);
          leftElbow.lerp(point(-0.90, 0.87, 0.50), dance);
          leftHand.lerp(point(-1.02 + Math.sin(this.actionAge * 8.5) * dance * 0.18,
            0.98 + Math.cos(this.actionAge * 8.5) * dance * 0.29, 0.83), dance);
        }
        leftGestures = true;
        break;
      case 'snooze':
        leftElbow.lerp(point(-0.62, 0.42, 0.45), holdEnvelope(this.actionAge, 2.35, 0.42, 0.34));
        leftHand.lerp(point(-0.28, 0.52, 0.69), holdEnvelope(this.actionAge, 2.35, 0.42, 0.34));
        leftGestures = true;
        break;
      case 'sing':
        {
          const sing = holdEnvelope(this.actionAge, 2.4, 0.24, 0.33);
          leftElbow.lerp(point(-0.90, 0.94, 0.48), sing);
          leftHand.lerp(point(-0.92 + Math.sin(this.actionAge * 6.5) * sing * 0.15,
            1.12 + Math.cos(this.actionAge * 6.5) * sing * 0.26, 0.82), sing);
        }
        leftGestures = true;
        break;
      case 'wink':
        {
          const wink = holdEnvelope(this.actionAge, 1.35, 0.23, 0.34);
          leftElbow.lerp(point(-0.71, 0.86, 0.51), wink);
          leftHand.lerp(point(-0.43, 1.10, 0.91), wink);
        }
        leftGestures = true;
        break;
      case 'shrug':
        {
          const shrug = holdEnvelope(this.actionAge, 1.8, 0.31, 0.38);
          leftElbow.lerp(point(-1.01, 0.93, 0.47), shrug);
          leftHand.lerp(point(-1.08, 1.18, 0.90), shrug);
        }
        leftGestures = true;
        break;
      case 'salute':
        {
          const salute = holdEnvelope(this.actionAge, 1.55, 0.23, 0.35);
          leftElbow.lerp(point(-0.81, 1.33, 0.44), salute);
          leftHand.lerp(point(-0.67, 1.88, 0.62), salute);
        }
        leftGestures = true;
        break;
      case 'scratch':
        {
          const scratch = holdEnvelope(this.actionAge, 1.85, 0.27, 0.32);
          leftElbow.lerp(point(-0.80, 1.28, 0.36), scratch);
          leftHand.lerp(point(-0.73, 1.79 + Math.sin(this.actionAge * 20) * 0.055,
            0.49), scratch);
        }
        leftGestures = true;
        break;
      case 'yawn':
        {
          const cover = holdEnvelope(this.actionAge - 0.34, 1.65, 0.40, 0.36);
          leftElbow.lerp(point(-0.62, 1.11, 0.67), cover);
          leftHand.lerp(point(-0.34, 1.30, 1.07), cover);
        }
        leftGestures = true;
        break;
      case 'hush':
        {
          const hush = holdEnvelope(this.actionAge, 1.65, 0.24, 0.39);
          leftElbow.lerp(point(-0.58, 1.19, 0.66), hush);
          leftHand.lerp(point(-0.12, 1.39, 1.01), hush);
        }
        leftGestures = true;
        break;
      case 'cheer':
        {
          const cheer = holdEnvelope(this.actionAge, 2.0, 0.25, 0.37);
          leftElbow.lerp(point(-0.79, 1.35, 0.48), cheer);
          leftHand.lerp(point(-0.92 + Math.sin(this.actionAge * 10) * cheer * 0.09,
            1.84 + Math.sin(this.actionAge * 10) * cheer * 0.07, 0.77), cheer);
        }
        leftGestures = true;
        break;
      case 'shiver':
        {
          const shiver = holdEnvelope(this.actionAge, 1.75, 0.25, 0.33);
          leftElbow.lerp(point(-0.68, 0.65, 0.48), shiver);
          leftHand.lerp(point(-0.30 + Math.sin(this.actionAge * 23) * shiver * 0.035,
            0.90, 0.79), shiver);
        }
        leftGestures = true;
        break;
      case 'bow':
        {
          const bow = holdEnvelope(this.actionAge, 1.95, 0.34, 0.43);
          leftElbow.lerp(point(-0.69, 0.61, 0.48), bow);
          leftHand.lerp(point(-0.30, 0.70, 0.82), bow);
        }
        leftGestures = true;
        break;
      case 'sneeze':
        {
          const prepare = holdEnvelope(this.actionAge, 0.55, 0.12, 0.14);
          const burst = holdEnvelope(this.actionAge - 0.53, 0.68, 0.07, 0.32);
          leftElbow.lerp(point(-0.64, 1.11, 0.68), prepare);
          leftHand.lerp(point(-0.37, 1.32, 1.08), prepare);
          leftElbow.lerp(point(-0.91, 0.69, 0.54), burst);
          leftHand.lerp(point(-0.87, 0.80, 0.79), burst);
        }
        leftGestures = true;
        break;
      case 'laugh':
        leftElbow.lerp(point(-0.66, 0.45, 0.55), holdEnvelope(this.actionAge, 1.65, 0.24, 0.31));
        leftHand.lerp(point(-0.38, 0.46 + Math.sin(now * 12) * pulse * 0.09, 0.80),
          holdEnvelope(this.actionAge, 1.65, 0.24, 0.31));
        leftGestures = true;
        if (!phonePose) rightHand.y -= Math.sin(now * 12) * pulse * 0.09;
        break;
      case 'yes':
        leftHand.y += pulse * 0.24;
        leftGestures = true;
        break;
      case 'no':
        leftHand.x -= pulse * 0.25;
        leftGestures = true;
        break;
      case 'tickle':
        leftHand.y += Math.sin(now * 15) * pulse * 0.09;
        if (!phonePose) rightHand.y -= Math.sin(now * 15) * pulse * 0.09;
        leftGestures = true;
        break;
      default:
        break;
    }

    this.poseWing(this.leftWing, leftElbow, leftHand, dt, paperGrip * (leftGestures ? 0 : 1));
    this.poseWing(this.rightWing, rightElbow, rightHand, dt, paperGrip * (rightGestures ? 0 : 1));
  }

  private poseWing(arm: Wing, targetElbow: THREE.Vector3, targetHand: THREE.Vector3, dt: number, grip: number): void {
    const holdingReceiver = arm.side === 1 && this.callHeld && this.action !== 'call';
    const serving = arm.side === 1 && (this.action === 'eat' || this.action === 'sip')
      && this.actionAge > 0.58;
    const weight = 1 - Math.exp(-(holdingReceiver ? 28 : serving ? 22 : 10 + grip * 8) * dt);
    arm.elbow.lerp(targetElbow, weight);
    arm.hand.lerp(targetHand, weight);
    const propWing = arm.side === 1 && (this.phone.visible || serving);
    bendWing(arm.surface, arm.side, arm.shoulder, arm.elbow, arm.hand,
      propWing ? 0.82 : grip > 0.5 ? 0.88 : 1,
      propWing || grip > 0.5 ? 1 : 0.35);
    arm.tip.position.copy(arm.hand);
    const wave = this.action === 'wave' && arm.side === -1
      ? Math.sin(this.actionAge * 13) * 0.27 : 0;
    const gesture = arm.side === -1 ?
      this.action === 'shrug' ? 0.43 :
      this.action === 'salute' ? -0.45 :
      this.action === 'cheer' ? -0.26 :
      this.action === 'hush' ? -0.28 :
      this.action === 'scratch' ? 0.24 : 0 : 0;
    arm.tip.rotation.z = damp(arm.tip.rotation.z,
      arm.side * (this.action === 'surprise' || this.action === 'gasp' ? 0.33 : -0.13)
        + wave + gesture + (arm.side === 1 && this.phone.visible ? this.headRig.rotation.z * 0.24 : 0), dt, 10);
    arm.tip.rotation.y = damp(arm.tip.rotation.y,
      -arm.side * grip * 1.02 + (arm.side === 1 && this.phone.visible ? -0.13 : 0), dt, 12);
    arm.tip.rotation.x = damp(arm.tip.rotation.x,
      grip * this.paper.rotation.x * 0.45
        + (this.action === 'sip' && arm.side === 1
          ? -0.10 * holdEnvelope(this.actionAge - 0.95, 0.80, 0.16, 0.20) : 0)
        + (arm.side === -1 && this.action === 'salute' ? 0.25 : 0), dt, 10);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const geometries = new Set<THREE.BufferGeometry>();
    const materials = new Set<THREE.Material>();
    const textures = new Set<THREE.Texture>();
    this.group.traverse(object => {
      const current = object as THREE.Mesh;
      if (!current.isMesh) return;
      geometries.add(current.geometry);
      const used = Array.isArray(current.material) ? current.material : [current.material];
      for (const material of used) {
        materials.add(material);
        if (SHARED_MATERIALS.has(material)) continue;
        const mappedMaterial = material as THREE.MeshStandardMaterial;
        for (const slot of ['map', 'bumpMap', 'normalMap', 'roughnessMap', 'alphaMap', 'emissiveMap'] as const) {
          const texture = mappedMaterial[slot];
          if (texture instanceof THREE.Texture) textures.add(texture);
        }
      }
    });
    geometries.forEach(geometry => geometry.dispose());
    textures.forEach(texture => texture.dispose());
    materials.forEach(material => { if (!SHARED_MATERIALS.has(material)) material.dispose(); });
    this.group.removeFromParent();
    releasePlumageMaps(this.plumageMaps);
  }
}
