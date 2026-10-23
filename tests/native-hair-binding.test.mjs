import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../preview/node_modules/three/build/three.module.js';
import {NATIVE_HAIR_BINDINGS, nativeHairSource, nativeHairTargets,
  auditNativeHairBindings} from '../preview/core/native-hair-binding.js';
import {NativeClip} from '../preview/core/native-motion.js';
import {NativeResourceLayer} from '../preview/core/native-resource-layer.js';

const row = (audit, target) => audit.bindings.find(binding => binding.target === target);
const source = [
  {name:'Bip001Head',parent:-1},
  {name:'Bone_Hair071_R',parent:0},
  {name:'Bone_Hair072_R',parent:1},
];
const target = [
  {name:'頭',parentIndex:-1},
  {name:'右侧发A1',parentIndex:0},
  {name:'右侧发A2',parentIndex:1}, // Unweighted PMX helper, absent in native rig.
  {name:'右侧发A3',parentIndex:2},
];

test('all 63 weighted rebuilt joints have explicit one-to-one audited aliases', () => {
  assert.equal(NATIVE_HAIR_BINDINGS.length,63);
  assert.equal(new Set(NATIVE_HAIR_BINDINGS.map(binding=>binding.target)).size,63);
  assert.equal(new Set(NATIVE_HAIR_BINDINGS.map(binding=>binding.source)).size,63);
  assert.equal(NATIVE_HAIR_BINDINGS.filter(binding=>binding.confidence==='topology-verified-edited-bind').length,4);
  for (const binding of NATIVE_HAIR_BINDINGS) {
    assert.match(binding.source,/^Bone_Hair/);
    assert.ok(Number.isFinite(binding.bindError)&&binding.bindError>=0&&binding.bindError<.31);
    assert.ok(binding.sourceParent&&binding.targetMappedParent);
  }
  assert.equal(nativeHairSource('后辫子中A1'),'Bone_Hair101_M');
  assert.equal(nativeHairSource('后辫子中A15'),'Bone_Hair141_L');
  assert.equal(nativeHairSource('左辫子B6'),'Bone_Hair124_L');
  assert.equal(nativeHairSource('右辫子CC22'),'Bone_Hair152_R');
});

test('reverse aliases are exact and immutable; unknown or similar names never guess', () => {
  assert.deepEqual(nativeHairTargets('Bone_Hair071_R'),['右侧发A1']);
  assert.deepEqual(nativeHairTargets('Bone_Hair071_L'),['左侧发A1']);
  assert.equal(nativeHairSource('右侧发A2'),null);
  assert.equal(nativeHairSource('左侧发A01'),null);
  assert.deepEqual(nativeHairTargets('Bone_Hair071'),[]);
  assert.throws(()=>nativeHairTargets('Bone_Hair071_R').push('wrong'),TypeError);
  assert.throws(()=>{NATIVE_HAIR_BINDINGS[0].source='wrong';},TypeError);
});

test('topology audit skips inserted target helpers and anchors the source to the head', () => {
  const audit=auditNativeHairBindings(source,target);
  assert.equal(audit.mapped,2);assert.equal(audit.topologyMatched,2);
  assert.equal(row(audit,'右侧发A1').targetMappedParentSource,'Bip001Head');
  assert.equal(row(audit,'右侧发A3').targetMappedParent,'右侧发A1');
  assert.equal(row(audit,'右侧发A3').actualSourceParent,'Bone_Hair071_R');
  assert.equal(row(audit,'右侧发A3').topologyMatch,true);
  assert.equal(audit.complete,false); // The fixture intentionally has only one strand.
});

test('wrong branching is detected even when both bone names exist', () => {
  const sourceWithWrongParent=source.map(bone=>({...bone}));
  sourceWithWrongParent[2].parent=0;
  const audit=auditNativeHairBindings(sourceWithWrongParent,target);
  assert.equal(row(audit,'右侧发A3').sourcePresent,true);
  assert.equal(row(audit,'右侧发A3').targetPresent,true);
  assert.equal(row(audit,'右侧发A3').topologyMatch,false);
  assert.equal(audit.topologyMatched,1);
});

test('Three.Bone hierarchy and sparse clips report coverage without inventing tracks', () => {
  const head=new THREE.Bone();head.name='頭';
  const first=new THREE.Bone();first.name='右侧发A1';head.add(first);
  const helper=new THREE.Bone();helper.name='右侧发A2';first.add(helper);
  const second=new THREE.Bone();second.name='右侧发A3';helper.add(second);
  const complete=auditNativeHairBindings(source,[head,first,helper,second]);
  assert.equal(complete.topologyMatched,2);
  const sparse=auditNativeHairBindings(source.slice(0,1),[head,first,helper,second]);
  assert.equal(sparse.mapped,0);assert.equal(sparse.topologyMatched,0);
  assert.equal(row(sparse,'右侧发A1').sourcePresent,false);
  assert.equal(row(sparse,'右侧发A1').targetPresent,true);
  assert.equal(sparse.missingSource,63);
});

test('a malformed helper ancestry terminates and fails topology validation', () => {
  const cyclic=target.map(bone=>({...bone}));cyclic[2].parentIndex=2;
  const audit=auditNativeHairBindings(source,cyclic);
  assert.equal(row(audit,'右侧发A3').topologyMatch,false);
});

test('authored long-hair replacement matches native world motion across inserted PMX helpers', () => {
  const rotation=(axis,angle)=>new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(...axis),angle);
  const convert=q=>({p:[0,0,0],q:[q.x,q.z,q.y,-q.w],s:[1,1,1]});
  const rest=[rotation([0,1,0],.35),rotation([1,0,0],-.3),rotation([0,0,1],.45)];
  const posed=[rest[0].clone().multiply(rotation([0,0,1],.4)),
    rest[1].clone().multiply(rotation([0,1,0],.2)),
    rest[2].clone().multiply(rotation([1,0,0],-.25))];
  const clip=new NativeClip({schema:1,additive:false,duration:1,frameCount:2,
    bones:source.map((bone,i)=>({...bone,...convert(rest[i])})),
    frames:[rest.map(convert),posed.map(convert)]});
  const root=new THREE.Group(),head=new THREE.Bone();head.name='頭';root.add(head);
  const first=new THREE.Bone();first.name='右侧发A1';head.add(first);
  const helper=new THREE.Bone();helper.name='右侧发A2';helper.position.set(0,-.4,0);first.add(helper);
  const second=new THREE.Bone();second.name='右侧发A3';second.position.set(0,-.4,0);helper.add(second);
  root.updateMatrixWorld(true);
  const bind=[head,first,helper,second].map(node=>({node,q:node.quaternion.clone(),
    p:node.position.clone(),s:node.scale.clone(),wq:node.getWorldQuaternion(new THREE.Quaternion())}));
  const layer=new NativeResourceLayer(clip,root,{kind:'ribbon',bindPose:bind,composition:'replace'});
  assert.equal(layer.rows.length,2);
  clip.sample(1);
  const expected=index=>clip.world[index].q.clone().multiply(clip.restWorld[index].q.clone().invert());
  head.quaternion.copy(expected(0));
  first.quaternion.copy(rotation([1,0,0],1.2)); // Existing body hair track must be replaced.
  second.quaternion.copy(rotation([0,1,0],-.8));
  const beforeHead=head.quaternion.clone(),beforeHelper=helper.position.clone();
  layer.apply(1);
  for (const [bone,index] of [[first,1],[second,2]]) {
    const error=expected(index).angleTo(bone.getWorldQuaternion(new THREE.Quaternion()));
    assert.ok(error<1e-7,`${bone.name}: world rotation error ${error}`);
  }
  assert.ok(head.quaternion.angleTo(beforeHead)<1e-7);
  assert.deepEqual(helper.position.toArray(),beforeHelper.toArray());
  const once=second.getWorldQuaternion(new THREE.Quaternion());layer.apply(1);
  assert.ok(once.angleTo(second.getWorldQuaternion(new THREE.Quaternion()))<1e-7);
});
