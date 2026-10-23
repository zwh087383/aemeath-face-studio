import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../preview/node_modules/three/build/three.module.js';
import {NativeClip} from '../preview/core/native-motion.js';
import {NativeResourceLayer} from '../preview/core/native-resource-layer.js';

const axis = {x: new THREE.Vector3(1, 0, 0), y: new THREE.Vector3(0, 1, 0), z: new THREE.Vector3(0, 0, 1)};
const rotation = (name, radians) => new THREE.Quaternion().setFromAxisAngle(axis[name], radians);
const transform = (q = new THREE.Quaternion(), p = [0, 0, 0], s = [1, 1, 1]) => ({
  p: [p[0], p[2], p[1]], q: [q.x, q.z, q.y, -q.w], s: [s[0], s[2], s[1]],
});
function clip(bones, frame) {
  return new NativeClip({schema: 1, additive: false, duration: 1, frameCount: 2,
    bones: bones.map(row => ({...row, ...transform(row.q)})),
    frames: [bones.map(row => transform(row.q)), frame],
  });
}
function rig(names) {
  const root = new THREE.Group(), bones = [];
  for (const [name, parent] of names) {
    const bone = new THREE.Bone();bone.name = name;
    (parent < 0 ? root : bones[parent]).add(bone);bones.push(bone);
  }
  root.updateMatrixWorld(true);return {root, bones};
}
function pose(root) {
  root.updateMatrixWorld(true);const rows = [];
  root.traverse(node => {if (node.isBone) rows.push({node,
    p: node.position.clone(), q: node.quaternion.clone(), s: node.scale.clone(),
    wq: node.getWorldQuaternion(new THREE.Quaternion()),
  });});return rows;
}
function restore(rows) {
  for (const row of rows) {row.node.position.copy(row.p);row.node.quaternion.copy(row.q);row.node.scale.copy(row.s);}
}
const nearQuaternion = (actual, expected) => assert.ok(1 - Math.abs(actual.clone().normalize().dot(expected.clone().normalize())) < 1e-10,
  `rotation differs: ${actual.toArray()} / ${expected.toArray()}`);

test('look maps PMX neck/head/eyes explicitly and excludes mouth, cheek, elbow and body', () => {
  const source = ['Bip001Spine', 'Bip001Neck', 'Bip001Head', 'Bip001LEye', 'Bip001REye',
    'Facial_Cheek_a_01_L', 'Facial_Mouth_a_01_L', 'Facial_Elbow_a_01_L'];
  const c = clip(source.map((name, i) => ({name, parent: i ? 0 : -1})), source.map(() => transform(rotation('y', .3))));
  const {root, bones} = rig([['上半身', -1], ['首', 0], ['頭', 1], ['左目', 2], ['右目', 2],
    ['Facial_Cheek_a_01_L', 2], ['Facial_Mouth_a_01_L', 2], ['Facial_Elbow_a_01_L', 0]]);
  const layer = new NativeResourceLayer(c, root, {kind: 'look', bindPose: pose(root)});
  assert.deepEqual(layer.snapshot().bones, ['首', '頭', '左目', '右目']);layer.apply(1);
  nearQuaternion(bones[0].quaternion, new THREE.Quaternion());
  for (const i of [5, 6, 7]) nearQuaternion(bones[i].quaternion, new THREE.Quaternion());
  nearQuaternion(bones[1].quaternion, rotation('y', .3));
});

test('body rotation stays intact and neck/head deltas inherit once, including backward seeking', () => {
  const names = ['Bip001Spine', 'Bip001Neck', 'Bip001Head'];
  const c = clip(names.map((name, i) => ({name, parent: i - 1})),
    [transform(rotation('x', 1.1)), transform(rotation('y', .2)), transform(rotation('z', .15))]);
  const {root, bones} = rig([['上半身', -1], ['首', 0], ['頭', 1]]);const bind = pose(root);
  bones[0].quaternion.copy(rotation('x', .6));bones[1].quaternion.copy(rotation('z', .1));
  bones[2].quaternion.copy(rotation('y', -.12));
  const base = pose(root), layer = new NativeResourceLayer(c, root, {kind: 'look', bindPose: bind});layer.apply(1);
  const expectedNeck = base[1].q.clone().multiply(rotation('y', .2));
  const expectedHead = base[2].q.clone().multiply(rotation('z', .15));
  nearQuaternion(bones[0].quaternion, base[0].q);nearQuaternion(bones[1].quaternion, expectedNeck);
  nearQuaternion(bones[2].quaternion, expectedHead);
  nearQuaternion(bones[2].getWorldQuaternion(new THREE.Quaternion()),
    base[0].q.clone().multiply(expectedNeck).multiply(expectedHead));
  const result = bones.map(b => b.quaternion.clone());
  for (const at of [0, .5, 1, 1]) {restore(base);layer.apply(at);}
  bones.forEach((bone, i) => nearQuaternion(bone.quaternion, result[i]));
  restore(base);layer.apply(0);bones.forEach((bone, i) => nearQuaternion(bone.quaternion, base[i].q));
});

test('bind-axis calibration transports a local delta without changing target bone lengths', () => {
  const sourceRest = rotation('y', Math.PI / 2), delta = rotation('x', .3);
  const c = clip([{name: 'Bip001Head', parent: -1, q: sourceRest}], [transform(sourceRest.clone().multiply(delta))]);
  const {root, bones: [head]} = rig([['頭', -1]]);
  head.quaternion.copy(rotation('z', -.3));head.position.set(0, 2, 0);head.scale.set(1, 1.2, 1);
  const bind = pose(root), bindWorld = bind[0].wq.clone();
  head.quaternion.copy(rotation('y', .4));const base = head.quaternion.clone();
  const layer = new NativeResourceLayer(c, root, {kind: 'look', bindPose: bind});layer.apply(1);
  const axes = bindWorld.invert().multiply(sourceRest);
  const expected = base.multiply(axes.clone().multiply(delta).multiply(axes.clone().invert()));
  nearQuaternion(head.quaternion, expected);assert.deepEqual(head.position.toArray(), [0, 2, 0]);
  assert.deepEqual(head.scale.toArray(), [1, 1.2, 1]);
});

test('ribbon overlays move only cloth/hair, preserving base movement and source local translation', () => {
  const c = clip([{name: 'Bip001Head', parent: -1}, {name: 'Bone_Hair001_M', parent: 0},
    {name: 'Bone_Piao001_L', parent: 1}, {name: 'Bone_HandTwist_L', parent: 0}],
    [transform(rotation('x', .9)), transform(rotation('y', .2), [3, 0, 0], [2, 1, 1]),
      transform(rotation('z', .1)), transform(rotation('x', .8))]);
  const {root, bones} = rig([['Bip001Head', -1], ['Bone_Hair001_M', 0], ['Bone_Piao001_L', 1], ['Bone_HandTwist_L', 0]]);
  const bind = pose(root);bones[0].quaternion.copy(rotation('z', .4));bones[1].position.set(0, 1, 0);
  bones[1].quaternion.copy(rotation('x', .1));const base = pose(root);
  const layer = new NativeResourceLayer(c, root, {kind: 'ribbon', native: true, bindPose: bind});
  assert.deepEqual(layer.snapshot().bones, ['Bone_Hair001_M', 'Bone_Piao001_L']);layer.apply(1);
  nearQuaternion(bones[0].quaternion, base[0].q);
  nearQuaternion(bones[1].quaternion, base[1].q.clone().multiply(rotation('y', .2)));
  nearQuaternion(bones[3].quaternion, base[3].q);
  assert.deepEqual(bones[1].position.toArray(), [.03, 1, 0]);assert.deepEqual(bones[1].scale.toArray(), [2, 1, 1]);
  const world = bones[2].getWorldQuaternion(new THREE.Quaternion());
  restore(base);layer.apply(0);restore(base);layer.apply(1);
  nearQuaternion(bones[2].getWorldQuaternion(new THREE.Quaternion()), world);
});
