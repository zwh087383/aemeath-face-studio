import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {fileURLToPath} from 'node:url';
import * as THREE from '../../preview/node_modules/three/build/three.module.js';
import {Parser} from '../../preview/node_modules/mmd-parser/build/mmdparser.module.mjs';
import {NativeClothBinding} from '../../preview/core/native-cloth-binding.js';
import {NativeBehaviorAdapter,buildNativeBehaviorPlan} from '../../preview/core/native-behavior-adapter.js';
import {NativeBehaviorPlayer,cloneNativePose,nativePoseVelocity} from '../../preview/core/native-behavior.js';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..'),output=path.join(root,'outputs/action-preparation-20261023/native-behaviors');
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const dataRoot=path.join(root,'outputs/native-complete-20261022');
const sourceFile=path.join(root,'outputs/native-motion-20261022/source-mesh/Client/Content/Aki/Character/Role/FemaleM/Aimisi/R2T1AimisiMd10011/Model/R2T1AimisiMd10011.glb');
const targetFile=path.join(root,'assets/Aemeath/鸣潮_爱弥斯1.05.pmx');

/** Exact binary GLTF geometry and bind hierarchy; no texture or rendering
 * approximation is involved in skinning. Materials deliberately omitted. */
export function parseSourceGLB(bytes){
  const json=JSON.parse(bytes.subarray(20,20+bytes.readUInt32LE(12)).toString('utf8'));
  const binaryAt=20+bytes.readUInt32LE(12)+8,binary=bytes.subarray(binaryAt),joints=new Set(json.skins.flatMap(s=>s.joints));
  const widths={SCALAR:1,VEC2:2,VEC3:3,VEC4:4,MAT4:16},components={5126:[4,'getFloat32',Float32Array],5123:[2,'getUint16',Uint16Array],5125:[4,'getUint32',Uint32Array],5121:[1,'getUint8',Uint8Array]};
  const accessor=index=>{const a=json.accessors[index],view=json.bufferViews[a.bufferView],[size,method,Type]=components[a.componentType],width=widths[a.type],stride=view.byteStride??size*width,offset=(view.byteOffset??0)+(a.byteOffset??0),data=new DataView(binary.buffer,binary.byteOffset,binary.byteLength),values=new Type(a.count*width);for(let i=0;i<a.count;i++)for(let k=0;k<width;k++)values[i*width+k]=data[method](offset+i*stride+k*size,true);return new THREE.BufferAttribute(values,width,a.normalized??false);};
  const nodes=json.nodes.map((row,i)=>{const n=joints.has(i)?new THREE.Bone():new THREE.Object3D();n.name=row.name??String(i);if(row.matrix)n.applyMatrix4(new THREE.Matrix4().fromArray(row.matrix));else{if(row.translation)n.position.fromArray(row.translation);if(row.rotation)n.quaternion.fromArray(row.rotation);if(row.scale)n.scale.fromArray(row.scale);}return n;});
  json.nodes.forEach((row,i)=>{for(const child of row.children??[])nodes[i].add(nodes[child]);});
  const source=new THREE.Group();source.name='Original GLTF scene';for(const index of json.scenes[json.scene??0].nodes)source.add(nodes[index]);source.updateMatrixWorld(true);
  json.nodes.forEach((row,i)=>{if(row.mesh===undefined)return;for(const primitive of json.meshes[row.mesh].primitives){const geometry=new THREE.BufferGeometry();for(const [sourceName,targetName] of [['POSITION','position'],['NORMAL','normal'],['TEXCOORD_0','uv'],['JOINTS_0','skinIndex'],['WEIGHTS_0','skinWeight']])if(primitive.attributes[sourceName]!==undefined)geometry.setAttribute(targetName,accessor(primitive.attributes[sourceName]));if(primitive.indices!==undefined)geometry.setIndex(accessor(primitive.indices));const mesh=new THREE.SkinnedMesh(geometry,new THREE.MeshBasicMaterial());nodes[i].add(mesh);const skin=json.skins[row.skin],values=accessor(skin.inverseBindMatrices).array,skeleton=new THREE.Skeleton(skin.joints.map(j=>nodes[j]),skin.joints.map((_,j)=>new THREE.Matrix4().fromArray(values,j*16)));mesh.bind(skeleton,new THREE.Matrix4());}});
  source.updateMatrixWorld(true);return source;
}
export function parseTargetPMX(bytes){
  const pmx=new Parser().parsePmx(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),true),geometry=new THREE.BufferGeometry();
  for(const [name,key,size] of [['position','position',3],['normal','normal',3],['uv','uv',2]])geometry.setAttribute(name,new THREE.Float32BufferAttribute(pmx.vertices.flatMap(v=>v[key]),size));
  geometry.setAttribute('skinIndex',new THREE.Uint16BufferAttribute(pmx.vertices.flatMap(v=>Array.from({length:4},(_,i)=>v.skinIndices[i]??0)),4));geometry.setAttribute('skinWeight',new THREE.Float32BufferAttribute(pmx.vertices.flatMap(v=>Array.from({length:4},(_,i)=>v.skinWeights[i]??0)),4));
  const mesh=new THREE.SkinnedMesh(geometry,new THREE.MeshBasicMaterial()),bones=pmx.bones.map(r=>{const n=new THREE.Bone();n.name=r.name;n.position.fromArray(r.position);return n;});
  pmx.bones.forEach((r,i)=>{if(r.parentIndex>=0){bones[i].position.sub(new THREE.Vector3(...pmx.bones[r.parentIndex].position));bones[r.parentIndex].add(bones[i]);}else mesh.add(bones[i]);});mesh.updateMatrixWorld(true);mesh.bind(new THREE.Skeleton(bones));return {mesh,pmx};
}

async function run(){
  fs.mkdirSync(output,{recursive:true});const begin=performance.now(),queueBytes=fs.readFileSync(path.join(root,'outputs/action-preparation-20261023/review-queue.json')),manifestBytes=fs.readFileSync(path.join(dataRoot,'manifest.json')),manifest=JSON.parse(manifestBytes),groups=JSON.parse(queueBytes).groups.filter(g=>g.kind==='native-body-family');
  const at=process.argv.indexOf('--limit'),only=process.argv.indexOf('--name'),selected=only>=0?groups.filter(g=>g.name===process.argv[only+1]):at>=0?groups.slice(0,Number(process.argv[at+1])):groups;
  const sourceBytes=fs.readFileSync(sourceFile),targetBytes=fs.readFileSync(targetFile),source=parseSourceGLB(sourceBytes),{mesh}=parseTargetPMX(targetBytes),cloth=new NativeClothBinding(source,mesh),adapter=new NativeBehaviorAdapter({source,mesh,cloth,manifest});
  const bindLengths=new Map(adapter.targetRest.map(r=>[r.node,r.p.length()])),targetIndices=adapter.nodes.map((n,i)=>adapter.targetRest.some(r=>r.node===n)?i:-1).filter(i=>i>=0);
  const vertexIndices=Array.from({length:Math.min(160,mesh.geometry.attributes.position.count)},(_,i)=>Math.floor(i*mesh.geometry.attributes.position.count/160));
  vertexIndices.push(...cloth.vertexIndices.filter((_,i)=>i%Math.max(1,Math.floor(cloth.vertexIndices.length/80))===0));
  const vector=new THREE.Vector3(),summary={schema:1,startedAt:new Date().toISOString(),source:'Actual PMX hierarchy/skin weights and GLTF skeleton/surface; existing NativeClip/NativeRetarget/NativeResourceLayer/exact NativeClothBinding; explicit behavior clock.',
    fingerprint:{queue:sha(queueBytes),manifest:sha(manifestBytes),sourceGLB:sha(sourceBytes),targetPMX:sha(targetBytes),modules:Object.fromEntries(['preview/core/native-behavior.js','preview/core/native-behavior-adapter.js','preview/core/native-motion.js','preview/core/native-resource-layer.js','preview/core/native-cloth-binding.js','preview/core/native-companion.js'].map(p=>[p,sha(fs.readFileSync(path.join(root,p)))]))},
    coverage:{requestedGroups:selected.length,allDirectoryGroups:groups.length,requestedClips:selected.reduce((n,g)=>n+g.memberIds.length,0),skinSampleVertices:vertexIndices.length,phases:'Each source phase is cancelled at 20%, 50%, 80%; both kinematic stop and same-directory End if present. Joins checked with backward/forward finite differences.',continuousSampling:'12 samples over each phase and each transition; numerical target validation does not substitute for continuous human viewing.'},
    thresholds:{targetLocalLengthError:1e-7,joinPositionGap:1e-7,joinRotationGapRadians:1e-6,finiteDifferenceStep:1e-5,velocityPositionGap:.05,velocityAngularGap:.05,units:'PMX model units; radians; per second. Thresholds detect numerical jump, not visual contact quality.'},
    limitations:['No automatic admission. Kinematic stop does not prove physical support, landing, chair, held prop or collision clearance.','Same-directory End from arbitrary phase is explicitly preview only; even perfect C0/C1 does not authorize it.','Full clips keep source timing/amplitude. Transition formulas are chosen implementation, not original game algorithms.','Matrix/CPU skin evidence does not prove GPU appearance or subjective naturalness.','Absolute horizontal trajectory is reanchored between phases from actual current pelvis; source vertical trajectory preserved.'],groups:[],failures:[]};
  const destination=path.join(output,at>=0||only>=0?'execution-smoke.json':'execution-all-groups.json');
  const read=async id=>{const row=manifest.clips.find(c=>c.id===id);return JSON.parse(gunzipSync(fs.readFileSync(path.join(dataRoot,row.file))));};
  const physical=pose=>{adapter.apply(pose);let maxLength=0,finite=true;for(const bone of mesh.skeleton.bones){finite&&=bone.matrixWorld.elements.every(Number.isFinite);if(bindLengths.has(bone)&&bone.name!=='腰')maxLength=Math.max(maxLength,Math.abs(bone.position.length()-bindLengths.get(bone)));}for(const i of vertexIndices){vector.fromBufferAttribute(mesh.geometry.attributes.position,i);mesh.applyBoneTransform(i,vector);finite&&=[...vector].every(Number.isFinite);}return {finite,maxLength};};
  const join=(a,b,c,h)=>{const left=nativePoseVelocity(a,b,h),right=nativePoseVelocity(b,c,h);let p=0,q=0;for(const i of targetIndices){p=Math.max(p,left[i].p.distanceTo(right[i].p));q=Math.max(q,left[i].q.distanceTo(right[i].q));}return {positionVelocityGap:p,angularVelocityGap:q};};
  for(const group of selected){const started=performance.now();try{
    const plan=buildNativeBehaviorPlan(group,manifest);await adapter.load(plan.map(p=>p.id),read);const initial=cloneNativePose(adapter.sample(plan[0].id,0)),create=()=>new NativeBehaviorPlayer({plan,sample:(id,t)=>adapter.sample(id,t),initialPose:initial,align:(a,b)=>adapter.alignment(a,b),stopOptions:adapter.stopOptions()});
    const result={id:group.id,name:group.name,sourceFamily:group.sourceFamily,clips:plan.map(p=>p.id),dependencyProfile:group.dependencyProfile,automaticEligible:false,initial:'This group first frame. Entry continuity tested from same existing pose; NOT a Stand2-to-seated transition.',seams:[],cancellations:[],sampledPoses:0,maxLengthError:0,finite:true,clothStates:[],failures:[]};
    let cursor=0;
    for(const phase of plan){for(let k=0;k<=12;k++){const p=create();p.advance(cursor+phase.duration*k/12);const state=physical(p.pose());result.sampledPoses++;result.finite&&=state.finite;result.maxLengthError=Math.max(result.maxLengthError,state.maxLength);}
      cursor+=phase.duration;
      if(cursor<plan.reduce((n,p)=>n+p.duration,0)){const h=1e-5,p=create();p.advance(cursor-h);const a=cloneNativePose(p.pose());p.advance(h);const b=cloneNativePose(p.pose());p.advance(h);const c=cloneNativePose(p.pose());result.seams.push({at:cursor,...join(a,b,c,h)});}
    }
    cursor=0;
    for(const phase of plan){for(const fraction of [.2,.5,.8])for(const useEnd of [false,...(plan.some(p=>p.phase==='end')?[true]:[])]){
      const p=create(),h=1e-5,when=cursor+phase.duration*fraction;p.advance(when-h);const a=cloneNativePose(p.pose());p.advance(h);const before=cloneNativePose(p.pose());const accepted=p.cancel({useEnd});const b=cloneNativePose(p.pose());p.advance(h);const after=cloneNativePose(p.pose());let c0p=0,c0q=0;for(const i of targetIndices){c0p=Math.max(c0p,before[i].p.distanceTo(b[i].p));c0q=Math.max(c0q,before[i].q.angleTo(b[i].q));}
      const row={id:phase.id,phase:phase.phase,fraction,route:useEnd?'same-directory-End-preview':'kinematic-stop',accepted:accepted.accepted,positionGap:c0p,rotationGapRadians:c0q,...join(a,b,after,h)};
      for(const dt of [0,.02,.05,.1,.2,.4,.8,2]){const state=physical(p.pose());result.sampledPoses++;result.finite&&=state.finite;result.maxLengthError=Math.max(result.maxLengthError,state.maxLength);p.advance(dt);}
      const epoch=p.epoch;p.reset();row.oldEpochRejected=p.cancel({epoch}).accepted===false;result.cancellations.push(row);
    }cursor+=phase.duration;}
    const pause=create();pause.advance(.1);pause.pause(true);const frozen=cloneNativePose(pause.pose());pause.advance(2);result.pauseFrozen=pause.time===.1&&frozen.every((r,i)=>r.p.distanceTo(pause.pose()[i].p)<1e-9&&r.q.angleTo(pause.pose()[i].q)<1e-6);
    result.clothStates=[...adapter.rows.values()].map(r=>({id:r.descriptor.id,companion:r.ribbon?.descriptor.id??null,composition:r.ribbon?.target.composition??null}));
    const checks=[...result.seams,...result.cancellations];result.passed=result.finite&&result.maxLengthError<1e-7&&result.pauseFrozen&&checks.every(r=>(r.positionGap??0)<1e-7&&(r.rotationGapRadians??0)<1e-6&&r.positionVelocityGap<.05&&r.angularVelocityGap<.05&&(r.oldEpochRejected??true));
    if(!result.passed)result.failures.push('Numerical execution criteria failed; inspect per-seam/cancellation measurements.');result.elapsedMs=performance.now()-started;summary.groups.push(result);if(!result.passed)summary.failures.push({id:group.id,name:group.name,error:result.failures});
  }catch(error){summary.failures.push({id:group.id,name:group.name,error:error.stack??error.message});}
    summary.elapsedMs=performance.now()-begin;summary.completedGroups=summary.groups.length;fs.writeFileSync(destination,JSON.stringify(summary,null,2)+'\n');console.log(`${summary.groups.length}/${selected.length} ${group.name} · failures ${summary.failures.length}`);
  }
  summary.finishedAt=new Date().toISOString();summary.elapsedMs=performance.now()-begin;summary.cloth=cloth.snapshot();summary.passed=summary.failures.length===0&&summary.groups.length===selected.length;fs.writeFileSync(destination,JSON.stringify(summary,null,2)+'\n');console.log(JSON.stringify({destination,groups:summary.groups.length,failures:summary.failures.length,elapsedMs:summary.elapsedMs,passed:summary.passed}));if(!summary.passed)process.exitCode=1;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await run();
