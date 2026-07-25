import * as THREE from 'three';
import { clone as skeletonClone } from 'three/examples/jsm/utils/SkeletonUtils.js';

/** Build a car group: clone the GLB template if present (preserving wheel tags), else the primitive. */
export function buildCar(template: THREE.Group | null, color: string, _isMe: boolean): THREE.Group {
  let g: THREE.Group;
  if (template) {
    // SkeletonUtils.clone rebinds SkinnedMesh instances to the cloned Skeleton, so the
    // 2nd+ instance of a rigged/animated GLB animates correctly (plain clone() does not).
    // It returns an Object3D; wrap in a Group if it isn't already one so we keep the THREE.Group contract.
    const cloned = skeletonClone(template);
    g = cloned instanceof THREE.Group ? cloned : new THREE.Group().add(cloned);
    // re-collect wheels on the clone by matching the template's wheel names
    const wheelNames = new Set((template.userData.wheels as THREE.Object3D[] ?? []).map(w => w.name));
    const wheels: THREE.Object3D[] = [];
    g.traverse(o => { if (wheelNames.has(o.name)) wheels.push(o); });
    g.userData.wheels = wheels;
    // If the model has a baked animation clip, set up a mixer to play it (preferred over wheel-spin).
    const clips = (template.userData.clips as THREE.AnimationClip[]) ?? [];
    if (clips.length > 0) {
      const mixer = new THREE.AnimationMixer(g);
      mixer.clipAction(clips[0]!).play();
      g.userData.mixer = mixer;   // renderer advances it each frame: mixer.update(dt)
    }
  } else {
    g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(2, 0.7, 3.4),
      new THREE.MeshStandardMaterial({ color, metalness: 0.35, roughness: 0.4 }));
    body.position.y = 0.75; g.add(body);
    const wheels: THREE.Object3D[] = [];
    for (const [x, z] of [[-1.05, -1.1], [1.05, -1.1], [-1.05, 1.1], [1.05, 1.1]]) {
      const w = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 0.4, 16),
        new THREE.MeshStandardMaterial({ color: 0x0a0d16 }));
      w.rotation.z = Math.PI / 2; w.position.set(x!, 0.5, z!); g.add(w); wheels.push(w);
    }
    g.userData.wheels = wheels;
  }
  return g;
}

export function buildPlayerMarker(color:string,playerNumber:number):THREE.Group {
  const marker=new THREE.Group();
  const material=new THREE.MeshBasicMaterial({color:new THREE.Color(color),depthTest:false,depthWrite:false});
  const cone=new THREE.Mesh(new THREE.ConeGeometry(0.72,1.45,4),material);
  cone.rotation.x=Math.PI;cone.renderOrder=20;marker.add(cone);
  marker.userData.isPlayerArrow=true;
  marker.userData.playerNumber=playerNumber;
  return marker;
}
