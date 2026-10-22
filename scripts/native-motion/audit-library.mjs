import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import * as THREE from '../../preview/node_modules/three/build/three.module.js';
import {Parser} from '../../preview/node_modules/mmd-parser/build/mmdparser.module.mjs';
import {NativeClip,NativeRetarget} from '../../preview/core/native-motion.js';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const out=path.join(root,'outputs/native-common-motions-20261022');
const manifest=JSON.parse(fs.readFileSync(path.join(out,'manifest.json')));
const pmxBytes=fs.readFileSync(path.join(root,'assets/Aemeath/鸣潮_爱弥斯1.05.pmx'));
const pmx=new Parser().parsePmx(pmxBytes.buffer.slice(pmxBytes.byteOffset,pmxBytes.byteOffset+pmxBytes.byteLength),true);
const mesh=new THREE.SkinnedMesh(new THREE.BufferGeometry(),new THREE.MeshBasicMaterial());
const bones=pmx.bones.map(b=>{const bone=new THREE.Bone();bone.name=b.name;bone.position.fromArray(b.position);return bone;});
for(let i=0;i<bones.length;i++){
  const parent=pmx.bones[i].parentIndex;
  if(parent>=0){bones[i].position.sub(new THREE.Vector3(...pmx.bones[parent].position));bones[parent].add(bones[i]);}
  else mesh.add(bones[i]);
}
mesh.updateMatrixWorld(true);mesh.bind(new THREE.Skeleton(bones));
const rest=bones.map(b=>({p:b.position.clone(),q:b.quaternion.clone(),s:b.scale.clone()}));
const results=[],accepted=[],rejected=[];
for(const row of manifest.clips){
  try{
    for(let i=0;i<bones.length;i++){bones[i].position.copy(rest[i].p);bones[i].quaternion.copy(rest[i].q);bones[i].scale.copy(rest[i].s);}
    mesh.updateMatrixWorld(true);
    const data=JSON.parse(fs.readFileSync(path.join(out,'clips',row.id+'.json'))),clip=new NativeClip(data),retarget=new NativeRetarget(clip,mesh);
    const sourcePelvis=clip.indices.get('Bip001Pelvis'),sourceHead=clip.indices.get('Bip001Head');
    const sourceRanges={pelvis:[],head:[]},jointErrors=[],first={};let maxLengthError=0,finite=true,lastSnapshot;
    for(let frame=0;frame<data.frameCount;frame++){
      clip.sample(data.duration*frame/(data.frameCount-1));retarget.apply();
      for(const [name,index] of [['pelvis',sourcePelvis],['head',sourceHead]])sourceRanges[name].push(clip.world[index].p.toArray());
      const snap=retarget.snapshot();maxLengthError=Math.max(maxLengthError,snap.maxLengthError);
      finite&&=Object.values(snap.bones).flat().every(Number.isFinite);
      if(frame===0)Object.assign(first,snap.bones);lastSnapshot=snap;
      for(const r of retarget.mapping.filter(r=>['頭','左ひじ','右ひじ','左手首','右手首','左足首','右足首'].includes(r.bone.name))){
        const target=r.bone.getWorldPosition(new THREE.Vector3()),native=clip.world[r.source].p.clone().multiplyScalar(retarget.scale);jointErrors.push(target.distanceTo(native));
      }
    }
    const range=list=>[0,1,2].map(i=>Math.max(...list.map(p=>p[i]))-Math.min(...list.map(p=>p[i])));
    const loopDifference=Math.max(...Object.entries(first).map(([n,p])=>Math.hypot(...p.map((v,i)=>v-lastSnapshot.bones[n][i]))));
    if(!finite||maxLengthError>1e-9)throw Error('Invalid target pose or changed bone lengths');
    const result={id:row.id,frameCount:data.frameCount,boneCount:data.bones.length,mapped:retarget.mapping.length,sourceSkeleton:data.sourceSkeleton,finite,maxLengthError,
      pelvisRangeCm:range(sourceRanges.pelvis),headHeightCm:[Math.min(...sourceRanges.head.map(p=>p[1])),Math.max(...sourceRanges.head.map(p=>p[1]))],
      loopPositionDelta:loopDifference,jointError:{rms:Math.sqrt(jointErrors.reduce((s,x)=>s+x*x,0)/jointErrors.length),max:Math.max(...jointErrors)},scale:retarget.scale};
    results.push(result);accepted.push({...row,audit:{finite:true,frames:data.frameCount,mappedBones:retarget.mapping.length,loopPositionDelta:loopDifference}});
    console.log(`OK ${row.id}: ${data.frameCount} frames; loop delta ${loopDifference.toFixed(4)}; head ${result.headHeightCm.map(x=>x.toFixed(1)).join('–')} cm`);
  }catch(error){rejected.push({id:row.id,error:error.message});console.log(`REJECT ${row.id}: ${error.message}`);}
  global.gc?.();
}
fs.writeFileSync(path.join(out,'offline-audit.json'),JSON.stringify({total:manifest.clips.length,accepted:accepted.length,rejected,clips:results},null,2));
fs.writeFileSync(path.join(out,'validated-manifest.json'),JSON.stringify({...manifest,clips:accepted},null,2));
console.log(JSON.stringify({accepted:accepted.length,rejected:rejected.length,frames:results.reduce((n,r)=>n+r.frameCount,0)}));
