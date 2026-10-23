import fs from 'node:fs';
import path from 'node:path';
import {gunzipSync} from 'node:zlib';
import * as THREE from '../../preview/node_modules/three/build/three.module.js';
import {Parser} from '../../preview/node_modules/mmd-parser/build/mmdparser.module.mjs';
import {NativeClip,NativeRetarget} from '../../preview/core/native-motion.js';
import {NativeResourceLayer} from '../../preview/core/native-resource-layer.js';
import {NATIVE_HAIR_BINDINGS,nativeHairSource,auditNativeHairBindings} from '../../preview/core/native-hair-binding.js';
const root=path.resolve(import.meta.dirname,'../..'),dir=path.join(root,'outputs/native-complete-20261022');
const manifest=JSON.parse(fs.readFileSync(path.join(dir,'manifest.json')));
const bytes=fs.readFileSync(path.join(root,'assets/Aemeath/鸣潮_爱弥斯1.05.pmx'));
const pmx=new Parser().parsePmx(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),true);
const geometry=new THREE.BufferGeometry();
geometry.setAttribute('position',new THREE.Float32BufferAttribute(pmx.vertices.flatMap(v=>v.position),3));
geometry.setAttribute('skinIndex',new THREE.Uint16BufferAttribute(pmx.vertices.flatMap(v=>Array.from({length:4},(_,k)=>v.skinIndices[k]??0)),4));
geometry.setAttribute('skinWeight',new THREE.Float32BufferAttribute(pmx.vertices.flatMap(v=>Array.from({length:4},(_,k)=>v.skinWeights[k]??0)),4));
const mesh=new THREE.SkinnedMesh(geometry,new THREE.MeshBasicMaterial());
const bones=pmx.bones.map(b=>{const node=new THREE.Bone();node.name=b.name;node.position.fromArray(b.position);return node;});
for(let i=0;i<bones.length;i++){const p=pmx.bones[i].parentIndex;if(p>=0){bones[i].position.sub(new THREE.Vector3(...pmx.bones[p].position));bones[p].add(bones[i]);}else mesh.add(bones[i]);}
mesh.updateMatrixWorld(true);mesh.bind(new THREE.Skeleton(bones));
const bind=bones.map(node=>({node,p:node.position.clone(),q:node.quaternion.clone(),s:node.scale.clone(),wq:node.getWorldQuaternion(new THREE.Quaternion())}));
const reset=()=>{for(const r of bind){r.node.position.copy(r.p);r.node.quaternion.copy(r.q);r.node.scale.copy(r.s);}mesh.updateMatrixWorld(true);};
const load=name=>{const row=manifest.clips.find(r=>r.name===name||r.id===name);return new NativeClip(JSON.parse(gunzipSync(fs.readFileSync(path.join(dir,row.file)))));};
const hairIndices=new Set(bones.map((b,i)=>nativeHairSource(b.name)?i:-1).filter(i=>i>=0));
const vertices=pmx.vertices.map((v,i)=>v.skinIndices.some((bone,k)=>hairIndices.has(bone)&&v.skinWeights[k]>1e-7)?i:-1).filter(i=>i>=0);
const v=new THREE.Vector3(),q=new THREE.Quaternion();
const skin=(i,headPos,headQ)=>mesh.applyBoneTransform(i,v.fromArray(pmx.vertices[i].position)).sub(headPos).applyQuaternion(headQ);
const results=[];
for(const name of ['面颊手势','Stand2']){
  const clip=load(name);reset();const oldRetarget=new NativeRetarget(clip,mesh),newRetarget=new NativeRetarget(clip,mesh);
  // Reproduce the pre-fix omission without modifying either source module.
  for(const [bone,row] of oldRetarget.byBone)if(nativeHairSource(bone.name))oldRetarget.byBone.delete(bone);
  const first=vertices.map(()=>new THREE.Vector3()),firstLocal=new Map();
  let maxProtectedPositionError=0,maxProtectedRotationError=0,maxHairLocalTemporalDegrees=0,maxVertexDisplacement=0,meanVertexDisplacement=0,maxLengthError=0;
  const head=bones.find(b=>b.name==='頭'),headPos=new THREE.Vector3(),headInv=new THREE.Quaternion();
  const protectedBones=bones.filter(b=>{let a=b;while(a?.isBone){if(nativeHairSource(a.name))return false;a=a.parent;}return true;});
  for(let j=0;j<=20;j++){
    clip.sample(clip.data.duration*j/20);oldRetarget.apply();
    const oldPos=protectedBones.map(b=>b.getWorldPosition(new THREE.Vector3())),oldQ=protectedBones.map(b=>b.getWorldQuaternion(new THREE.Quaternion()));
    newRetarget.apply();
    protectedBones.forEach((b,k)=>{maxProtectedPositionError=Math.max(maxProtectedPositionError,oldPos[k].distanceTo(b.getWorldPosition(v)));maxProtectedRotationError=Math.max(maxProtectedRotationError,oldQ[k].angleTo(b.getWorldQuaternion(q)));});
    for(const i of hairIndices){if(j===0)firstLocal.set(i,bones[i].quaternion.clone());maxHairLocalTemporalDegrees=Math.max(maxHairLocalTemporalDegrees,firstLocal.get(i).angleTo(bones[i].quaternion)*180/Math.PI);}
    head.getWorldPosition(headPos);head.getWorldQuaternion(headInv).invert();
    let frameTotal=0;
    for(let k=0;k<vertices.length;k++){const position=skin(vertices[k],headPos,headInv);if(j===0)first[k].copy(position);const d=first[k].distanceTo(position);frameTotal+=d;maxVertexDisplacement=Math.max(maxVertexDisplacement,d);}
    meanVertexDisplacement=Math.max(meanVertexDisplacement,frameTotal/vertices.length);
    maxLengthError=Math.max(maxLengthError,newRetarget.snapshot().maxLengthError);
  }
  results.push({name,mapped:newRetarget.mapping.length,longHairMapped:newRetarget.snapshot().nativeLongHairMapped,skinnedHairVertices:vertices.length,protectedBones:protectedBones.length,maxProtectedPositionError,maxProtectedRotationError,maxHairLocalTemporalDegrees,maxVertexDisplacement,meanVertexDisplacement,maxLengthError});
}

const layerResults=[];
for(const bodyName of ['Stand2','面颊手势']){
  const body=load(bodyName),hybrid=load(bodyName),ribbon=load('Rib_Stand2');reset();
  const retarget=new NativeRetarget(body,mesh),layer=new NativeResourceLayer(ribbon,mesh,{kind:'ribbon',native:false,bindPose:bind,composition:'replace'});
  const filter=name=>/^(?:Bone_)?(?:Hair|Piao|Ribbon|Skirt|Cloth|Sleeve|Dress|Coat|Scarf)/i.test(name);
  let maxWorldError=0,maxHeadRelativeError=0,maxProtectedPositionError=0,maxProtectedRotationError=0;
  const perBone=new Map(NATIVE_HAIR_BINDINGS.map(row=>[row.target,0]));
  const head=bones.find(b=>b.name==='頭');
  const protectedBones=bones.filter(b=>!layer.rows.some(row=>{let n=b;while(n?.isBone){if(n===row.bone)return true;n=n.parent;}return false;}));
  for(let j=0;j<=40;j++){
    const t=body.data.duration*j/40;body.sample(t);hybrid.sample(t);ribbon.sample(t%ribbon.data.duration);retarget.apply();
    const before=protectedBones.map(b=>({p:b.getWorldPosition(new THREE.Vector3()),q:b.getWorldQuaternion(new THREE.Quaternion())}));
    for(let i=0;i<hybrid.data.bones.length;i++)if(filter(hybrid.data.bones[i].name)){
      const ri=ribbon.indices.get(hybrid.data.bones[i].name);if(ri===undefined)continue;
      hybrid.local[i].p.copy(ribbon.local[ri].p);hybrid.local[i].q.copy(ribbon.local[ri].q);hybrid.local[i].s.copy(ribbon.local[ri].s);
    }
    hybrid.updateWorld();layer.apply(t%ribbon.data.duration);
    const sourceHead=hybrid.world[hybrid.indices.get('Bip001Head')].q;
    const expectedHead=sourceHead.clone().multiply(hybrid.restWorld[hybrid.indices.get('Bip001Head')].q.clone().invert());
    const actualHead=head.getWorldQuaternion(new THREE.Quaternion());
    for(const binding of NATIVE_HAIR_BINDINGS){
      const i=hybrid.indices.get(binding.source),bone=bones.find(b=>b.name===binding.target);
      const expected=hybrid.world[i].q.clone().multiply(hybrid.restWorld[i].q.clone().invert());
      const actual=bone.getWorldQuaternion(new THREE.Quaternion());
      const err=expected.angleTo(actual)*180/Math.PI;maxWorldError=Math.max(maxWorldError,err);perBone.set(binding.target,Math.max(perBone.get(binding.target),err));
      maxHeadRelativeError=Math.max(maxHeadRelativeError,expectedHead.clone().invert().multiply(expected).angleTo(actualHead.clone().invert().multiply(actual))*180/Math.PI);
    }
    protectedBones.forEach((bone,i)=>{maxProtectedPositionError=Math.max(maxProtectedPositionError,before[i].p.distanceTo(bone.getWorldPosition(v)));maxProtectedRotationError=Math.max(maxProtectedRotationError,before[i].q.angleTo(bone.getWorldQuaternion(q)));});
  }
  layerResults.push({body:bodyName,ribbon:'Rib_Stand2',mapped:layer.rows.length,longHairMapped:layer.rows.filter(row=>nativeHairSource(row.bone.name)).length,maxWorldErrorDegrees:maxWorldError,maxHeadRelativeErrorDegrees:maxHeadRelativeError,maxProtectedPositionError,maxProtectedRotationError,perBone:[...perBone].map(([name,degrees])=>({name,degrees}))});
}
const result={schema:1,model:'PMX 1.05 read only',samples:21,body:results,layerSamples:41,layers:layerResults};
const evidence=path.join(root,'outputs/hair-binding-20261022');fs.mkdirSync(evidence,{recursive:true});fs.writeFileSync(path.join(evidence,'fixed-actual-skin-audit.json'),JSON.stringify(result,null,2));
console.log(JSON.stringify({body:results,layers:layerResults.map(({perBone,...x})=>x)},null,2));
if(results.some(r=>r.maxProtectedPositionError>1e-7||r.maxProtectedRotationError>1e-6||r.maxLengthError>1e-7)||layerResults.some(r=>r.maxWorldErrorDegrees>1e-3))process.exitCode=1;
