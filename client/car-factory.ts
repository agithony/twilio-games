import * as THREE from 'three';

/** Build a car group: clone the GLB template if present (preserving wheel tags), else the primitive. */
export function buildCar(template: THREE.Group | null, color: string, isMe: boolean): THREE.Group {
  let g: THREE.Group;
  if (template) {
    g = template.clone(true);
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
  if (isMe) {
    const cone = new THREE.Mesh(new THREE.ConeGeometry(0.7, 1.4, 4),
      new THREE.MeshBasicMaterial({ color: 0x36d1dc }));
    cone.rotation.x = Math.PI; cone.position.y = 4; g.add(cone);
  }
  return g;
}
