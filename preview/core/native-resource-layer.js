import * as THREE from 'three';
import {nativeHairTargets} from './native-hair-binding.js';

// The source skeleton also has facial-mouth, cheek and Facial_Elbow helpers.
// Only these explicitly identified head/neck/eye bones belong to a look layer.
const lookAliases = {
  Bip001Neck: ['首'], Bip001Head: ['頭'],
  Bip001LEye: ['左目'], Bip001REye: ['右目'],
  Eye_L: ['左目'], Eye_R: ['右目'],
  Facial_Eye_L: ['左目'], Facial_Eye_R: ['右目'],
};
const filters = {
  look: name => Object.hasOwn(lookAliases, name),
  ribbon: name => /^(?:Bone_)?(?:Hair|Piao|Ribbon|Skirt|Cloth|Sleeve|Dress|Coat|Scarf)/i.test(name),
  'prop-animation': name => !/^Bip001/.test(name),
};
const depth = bone => bone.parent ? depth(bone.parent) + 1 : 0;

/** Restricted rest-relative bone layer: additive look or authored track replacement.
 * The host must apply/restore its body pose before every call, including seeks.
 * Capture every base world rotation before changing any layer bone. Only each
 * bone's local-track delta is added; its parent's delta is inherited once.
 * PMX rotations preserve target positions, lengths and scale. */
export class NativeResourceLayer {
  constructor(clip, root, {kind, native = false, bindPose = [], composition = 'additive'} = {}) {
    const filter = filters[kind];
    if (!filter) throw Error('Unsupported resource layer ' + kind);
    if(!['additive','replace'].includes(composition))throw Error('Unsupported layer composition');
    this.clip = clip;this.root = root;this.kind = kind;this.native = native;this.composition=composition;
    root.updateMatrixWorld(true);
    const binds = new Map(bindPose.map(row => [row.node.name, row]));
    const mapped = new Set();
    this.rows = [];
    for (let index = 0; index < clip.data.bones.length; index++) {
      const name = clip.data.bones[index].name;
      if (!filter(name)) continue;
      const names = native ? [name] : [name, ...(lookAliases[name] ?? []), ...nativeHairTargets(name)];
      const bone = names.map(candidate => root.getObjectByName(candidate)).find(candidate => candidate?.isBone);
      if (!bone || mapped.has(bone)) continue;
      mapped.add(bone);
      const bindWorld = binds.get(bone.name)?.wq?.clone() ?? bone.getWorldQuaternion(new THREE.Quaternion());
      // Conjugation converts a source bind-axis local delta to target bind axes.
      const axes = native ? new THREE.Quaternion() : bindWorld.invert().multiply(clip.restWorld[index].q).normalize();
      this.rows.push({bone, index, axes, axesInv: axes.clone().invert(),
        restInv: clip.rest[index].q.clone().invert(),
        bindLocal:binds.get(bone.name)?.q?.clone()??bone.quaternion.clone(),
        bindPosition:binds.get(bone.name)?.p?.clone()??bone.position.clone(),
        bindScale:binds.get(bone.name)?.s?.clone()??bone.scale.clone(),
        baseWorld: new THREE.Quaternion(), baseLocal: new THREE.Quaternion(),
        basePosition: new THREE.Vector3(), baseScale: new THREE.Vector3(),
      });
    }
    this.rows.sort((a, b) => depth(a.bone) - depth(b.bone));
    this.delta = new THREE.Quaternion();this.q = new THREE.Quaternion();
    this.translation = new THREE.Vector3();this.scaleRatio = new THREE.Vector3();
  }
  apply(seconds) {
    this.clip.sample(seconds);
    this.root.updateMatrixWorld(true);
    // Snapshot all bases first: an already modified parent must not contaminate
    // a child's base and accidentally apply that parent's delta a second time.
    for (const row of this.rows) {
      const {bone} = row;
      bone.getWorldQuaternion(row.baseWorld);
      row.baseLocal.copy(bone.quaternion);
      row.basePosition.copy(bone.position);row.baseScale.copy(bone.scale);
    }
    for (const row of this.rows) {
      const {bone, index, axes, axesInv, restInv} = row;
      const local = this.clip.local[index], rest = this.clip.rest[index];
      this.delta.copy(axes).multiply(restInv).multiply(local.q).multiply(axesInv).normalize();
      // Keep the exact captured local rotation: decomposing base world matrices
      // back into rotations can introduce shear errors under nonuniform scale.
      // The current parent supplies its layered rotation by inheritance once.
      // A full-pose ribbon companion owns these local tracks. Replace the
      // body's hair tracks rather than adding the same authored motion twice.
      const replace=this.composition==='replace';
      this.q.copy(replace?row.bindLocal:row.baseLocal).multiply(this.delta).normalize();
      bone.quaternion.copy(this.q);
      if (this.native) {
        this.translation.copy(local.p).sub(rest.p).multiplyScalar(.01);
        bone.position.copy(replace?row.bindPosition:row.basePosition).add(this.translation);
        this.scaleRatio.set(rest.s.x === 0 ? 1 : local.s.x / rest.s.x,
          rest.s.y === 0 ? 1 : local.s.y / rest.s.y, rest.s.z === 0 ? 1 : local.s.z / rest.s.z);
        bone.scale.copy(replace?row.bindScale:row.baseScale).multiply(this.scaleRatio);
      }
    }
    this.root.updateMatrixWorld(true);
    this.root.traverse(node => {if (node.isSkinnedMesh) node.skeleton.update();});
  }
  snapshot() {return {kind:this.kind, native:this.native, mapped:this.rows.length,
    bones:this.rows.map(row => row.bone.name), time:this.clip.time,
    composition:this.composition==='replace'?'authored local tracks replace the body hair/cloth tracks':'rest-local delta on a freshly applied body base',
    translations:this.native?'source local deltas':'preserved target positions'};}
}
