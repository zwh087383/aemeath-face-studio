import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../preview/node_modules/three/build/three.module.js';
import {NativeClothBinding,nativeSkirtTargetBone} from '../preview/core/native-cloth-binding.js';

const q=(axis,angle)=>new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(...axis),angle);
function fixture() {
  const parent=new THREE.Group(),source=new THREE.Group(),target=new THREE.SkinnedMesh();
  source.position.set(-2,.5,1);source.quaternion.copy(q([0,1,0],.2));parent.add(source);
  const sourcePelvis=new THREE.Bone();sourcePelvis.name='Bip001Pelvis';sourcePelvis.position.set(.1,.4,-.2);
  sourcePelvis.quaternion.copy(q([1,0,0],.45));source.add(sourcePelvis);
  const left=new THREE.Bone();left.name='Bone_Skirt001_L';left.position.set(.2,-.3,.1);left.quaternion.copy(q([0,0,1],-.35));sourcePelvis.add(left);
  const right=new THREE.Bone();right.name='Bone_Skirt001_R';right.position.set(-.2,-.3,.1);right.quaternion.copy(q([0,1,0],.3));sourcePelvis.add(right);
  const positions=[-.5,.1,.2, .5,.1,.2, 0,-.4,.2, 0,-.4,.2, 1,2,3];
  const uv=[0,0, 1,0, .3,.7, .9,.2, .5,.5],normal=[0,0,1,0,0,1,0,0,1,0,0,1,0,1,0];
  const geo=new THREE.BufferGeometry();geo.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));
  geo.setAttribute('normal',new THREE.Float32BufferAttribute(normal,3));geo.setAttribute('uv',new THREE.Float32BufferAttribute(uv,2));
  geo.setAttribute('skinIndex',new THREE.Uint16BufferAttribute([1,0,0,0, 2,0,0,0, 1,2,0,0, 2,1,0,0, 0,0,0,0],4));
  geo.setAttribute('skinWeight',new THREE.Float32BufferAttribute([.8,.2,0,0, .7,.3,0,0, .6,.3,.1,0, .1,.8,.1,0, 1,0,0,0],4));
  const sourceMesh=new THREE.SkinnedMesh(geo,new THREE.MeshBasicMaterial());source.add(sourceMesh);
  parent.updateMatrixWorld(true);sourceMesh.bind(new THREE.Skeleton([sourcePelvis,left,right]));
  const targetParent=new THREE.Group();targetParent.position.set(4,-3,2);targetParent.quaternion.copy(q([0,1,0],.55));
  targetParent.scale.set(1.2,.8,1.1);targetParent.add(target);target.position.set(.3,.2,-.1);
  const pelvis=new THREE.Bone();pelvis.name='下半身';pelvis.position.set(.3,4,-.2);pelvis.quaternion.copy(q([0,0,1],-.4));target.add(pelvis);
  const grid=new THREE.Bone();grid.name='スカート_0_1';grid.position.set(1,-1,.2);pelvis.add(grid);
  const targetGeo=geo.clone();const tPositions=targetGeo.getAttribute('position');
  for(let i=0;i<tPositions.count;i++)tPositions.setXYZ(i,tPositions.getX(i)*10,tPositions.getY(i)*10,tPositions.getZ(i)*10);
  // The second duplicated source point has a different UV and different weights.
  // Only the native UV .9,.2 point belongs to this target seam vertex.
  targetGeo.setAttribute('skinIndex',new THREE.Uint16BufferAttribute([1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,0,0,0,0],4));
  targetGeo.setAttribute('skinWeight',new THREE.Float32BufferAttribute([1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0],4));
  target.geometry=targetGeo;target.material=new THREE.MeshBasicMaterial();targetParent.updateMatrixWorld(true);
  target.bind(new THREE.Skeleton([pelvis,grid]));
  return {parent,source,sourceMesh,sourcePelvis,left,right,targetParent,target,pelvis,grid};
}
const names=new Set(['Bip001Pelvis','Bone_Skirt001_L','Bone_Skirt001_R']);
const point=(mesh,i)=>mesh.applyBoneTransform(i,new THREE.Vector3().fromBufferAttribute(mesh.geometry.getAttribute('position'),i));
const close=(a,b,tolerance=2e-5)=>assert.ok(a.distanceTo(b)<tolerance,`${a.toArray()} != ${b.toArray()}`);

test('only explicitly identified dense skirt and skirt connectors are selected',()=>{
  for(const name of ['スカート_0_0','左侧裙_10_2','右侧裙_0_3','左裙D','右裙A'])assert.equal(nativeSkirtTargetBone(name),true);
  for(const name of ['左袖子_1_0','右缎带_0_1','后辫子中A1','左裙DD','スカートfoo','Bone_Skirt001_L'])assert.equal(nativeSkirtTargetBone(name),false);
});

test('bind pose remains exactly unchanged across nontrivial pelvis axes and transformed model parents',()=>{
  const f=fixture(),beforePositions=Array.from(f.target.geometry.getAttribute('position').array),originalBones=f.target.skeleton.bones.length;
  const binding=new NativeClothBinding(f.source,f.target);assert.equal(binding.snapshot().matchedVertices,4);
  assert.equal(binding.snapshot().sourceBones,3);assert.ok(Math.abs(binding.snapshot().scale-10)<1e-6);
  assert.equal(f.target.skeleton.bones.length,originalBones+3);
  for(const row of binding.rows)assert.equal(row.node.userData.nativeClothVirtual,true);
  binding.apply({availableSourceNames:names});assert.equal(binding.snapshot().active,true);
  for(const i of binding.vertexIndices)close(point(f.target,i),new THREE.Vector3(...beforePositions.slice(i*3,i*3+3)),2e-6);
  assert.deepEqual(Array.from(f.target.geometry.getAttribute('position').array),beforePositions);
});

test('actual source skin deformation is pelvis corrected once, including translation and changing display scale',()=>{
  const f=fixture(),binding=new NativeClothBinding(f.source,f.target),sourceRest=new Map();
  const srcInv=f.source.matrixWorld.clone().invert();
  for(const bone of [f.sourcePelvis,f.left,f.right])sourceRest.set(bone.name,srcInv.clone().multiply(bone.matrixWorld));
  const tRest=f.target.matrixWorld.clone().invert().multiply(f.pelvis.matrixWorld);
  f.sourcePelvis.position.add(new THREE.Vector3(.3,-.2,.1));f.sourcePelvis.quaternion.multiply(q([0,1,0],.7));
  f.left.position.add(new THREE.Vector3(.02,-.03,.05));f.left.quaternion.multiply(q([1,0,0],.6));
  f.right.quaternion.multiply(q([0,0,1],-.25));
  f.pelvis.position.add(new THREE.Vector3(1.3,-.5,.2));f.pelvis.quaternion.multiply(q([1,0,0],-.5));
  f.source.scale.setScalar(13.7);f.source.position.add(new THREE.Vector3(7,-4,3));
  f.targetParent.quaternion.multiply(q([0,0,1],.4));f.parent.updateMatrixWorld(true);f.targetParent.updateMatrixWorld(true);
  binding.apply({availableSourceNames:names});
  const currentSrcInv=f.source.matrixWorld.clone().invert(),sCurrentInv=currentSrcInv.clone().multiply(f.sourcePelvis.matrixWorld).invert(),
    targetDelta=f.target.matrixWorld.clone().invert().multiply(f.pelvis.matrixWorld).multiply(tRest.clone().invert());
  for(const i of binding.vertexIndices) {
    const sourcePosition=new THREE.Vector3().fromBufferAttribute(f.target.geometry.getAttribute('position'),i).multiplyScalar(.1),
      expected=new THREE.Vector3();
    for(let k=0;k<4;k++) {
      const w=f.sourceMesh.geometry.getAttribute('skinWeight').getComponent(i,k);if(!w)continue;
      const bone=f.sourceMesh.skeleton.bones[f.sourceMesh.geometry.getAttribute('skinIndex').getComponent(i,k)];
      const deformed=sourcePosition.clone().applyMatrix4(sourceRest.get(bone.name).clone().invert())
        .applyMatrix4(currentSrcInv.clone().multiply(bone.matrixWorld));expected.addScaledVector(deformed,w);
    }
    expected.applyMatrix4(sCurrentInv).applyMatrix4(sourceRest.get('Bip001Pelvis')).multiplyScalar(10).applyMatrix4(targetDelta);
    close(point(f.target,i),expected,1e-5);
  }
});

test('UV identity disambiguates coincident surface vertices carrying different native weights',()=>{
  const f=fixture(),binding=new NativeClothBinding(f.source,f.target);binding.apply({availableSourceNames:names});
  const third=binding.nativeRows.find(row=>row.index===2),fourth=binding.nativeRows.find(row=>row.index===3);
  assert.ok(Math.abs(third.weights[0]-.6)<1e-6);assert.ok(Math.abs(fourth.weights[0]-.1)<1e-6);
  assert.notDeepEqual(third.weights,fourth.weights);
});

test('toggles and sparse-source fallback reuse palette and attributes, restoring byte exact original weights',()=>{
  const f=fixture(),oldIndex=Array.from(f.target.geometry.getAttribute('skinIndex').array),oldWeight=Array.from(f.target.geometry.getAttribute('skinWeight').array),
    binding=new NativeClothBinding(f.source,f.target),palette=f.target.skeleton,index=f.target.geometry.getAttribute('skinIndex'),weight=f.target.geometry.getAttribute('skinWeight');
  const nonSkirtIndex=oldIndex.slice(16),nonSkirtWeight=oldWeight.slice(16);
  binding.apply({availableSourceNames:names});
  assert.deepEqual(Array.from(index.array).slice(16),nonSkirtIndex);assert.deepEqual(Array.from(weight.array).slice(16),nonSkirtWeight);
  binding.setEnabled(false);assert.equal(binding.snapshot().active,false);
  assert.deepEqual(Array.from(index.array),oldIndex);assert.deepEqual(Array.from(weight.array),oldWeight);
  binding.setEnabled(true).apply({availableSourceNames:names});assert.equal(binding.snapshot().active,true);
  binding.apply({availableSourceNames:new Set(['Bip001Pelvis'])});assert.equal(binding.snapshot().active,false);
  assert.equal(binding.snapshot().missingSourceCount,2);assert.match(binding.snapshot().reason,/Missing source/);
  assert.deepEqual(Array.from(index.array),oldIndex);assert.deepEqual(Array.from(weight.array),oldWeight);
  binding.apply({availableSourceNames:names});assert.equal(binding.snapshot().active,true);
  binding.restore();assert.equal(binding.snapshot().enabled,false);
  assert.equal(f.target.skeleton,palette);assert.equal(f.target.geometry.getAttribute('skinIndex'),index);assert.equal(f.target.geometry.getAttribute('skinWeight'),weight);
});

test('incomplete surface matches fail atomically before changing target geometry or palette',()=>{
  const f=fixture(),palette=f.target.skeleton,index=f.target.geometry.getAttribute('skinIndex'),weight=f.target.geometry.getAttribute('skinWeight');
  f.target.geometry.getAttribute('uv').setXY(0,.6,.6);
  const children=f.target.children.length;
  assert.throws(()=>new NativeClothBinding(f.source,f.target),/correspondence incomplete|No same-surface/);
  assert.equal(f.target.skeleton,palette);assert.equal(f.target.geometry.getAttribute('skinIndex'),index);
  assert.equal(f.target.geometry.getAttribute('skinWeight'),weight);assert.equal(f.target.children.length,children);
});

test('edited normals require an exact surface identity and equivalent native skinning at that position',()=>{
  const safe=fixture();safe.target.geometry.getAttribute('normal').setXYZ(0,1,0,0);
  const binding=new NativeClothBinding(safe.source,safe.target);assert.equal(binding.snapshot().editedNormalVertices,1);
  binding.apply({availableSourceNames:names});assert.equal(binding.snapshot().active,true);
  const ambiguous=fixture();ambiguous.target.geometry.getAttribute('normal').setXYZ(2,1,0,0);
  const original=ambiguous.target.skeleton;
  assert.throws(()=>new NativeClothBinding(ambiguous.source,ambiguous.target),/correspondence incomplete|No same-surface/);
  assert.equal(ambiguous.target.skeleton,original);
});
