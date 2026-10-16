import * as THREE from 'three';

/** Bind-pose skeleton description (model space) for the pure motion core.
 * Call before any bone is animated. */
export function skeletonFromMesh(mesh) {
  mesh.updateMatrixWorld(true);
  const world = new THREE.Vector3();
  return new Map(mesh.skeleton.bones.map(bone => [bone.name, {
    position: bone.getWorldPosition(world).toArray(),
    parent: bone.parent?.isBone ? bone.parent.name : null,
  }]));
}

/** Writes the motion layer's local rotations onto PMX bones. The caller resets all
 * bones to their stored rest transform first, so nothing accumulates between frames.
 * MMD grant constraints (twist helpers, shoulder adjusters, eyes) are then solved by
 * the MMDAnimationHelper update that follows. */
export class MotionRig {
  constructor(mesh) {
    this.byName = new Map(mesh.skeleton.bones.map(bone => [bone.name, { bone, rest: bone.quaternion.clone(), position: bone.position.clone() }]));
    this.scratch = new THREE.Quaternion();
    this.missing = new Set();
    this.translated = new Set();
  }

  apply(locals) {
    for (const name of this.translated) {
      const entry = this.byName.get(name);
      if (entry) entry.bone.position.copy(entry.position);
    }
    this.translated.clear();
    for (const [name, offset] of locals.translations ?? []) {
      const entry = this.byName.get(name);
      if (!entry) { this.missing.add(name); continue; }
      entry.bone.position.copy(entry.position);
      entry.bone.position.x += offset[0]; entry.bone.position.y += offset[1]; entry.bone.position.z += offset[2];
      this.translated.add(name);
    }
    for (const [name, q] of locals) {
      const entry = this.byName.get(name);
      if (!entry) { this.missing.add(name); continue; }
      this.scratch.set(q[0], q[1], q[2], q[3]);
      entry.bone.quaternion.copy(entry.rest).multiply(this.scratch);
    }
  }
}
