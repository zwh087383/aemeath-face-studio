import fs from 'node:fs';
import path from 'node:path';
import {gunzipSync} from 'node:zlib';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import * as THREE from '../../preview/node_modules/three/build/three.module.js';
import {Parser} from '../../preview/node_modules/mmd-parser/build/mmdparser.module.mjs';
import {NativeClip,NativeRetarget} from '../../preview/core/native-motion.js';
import {NativeExpression,NativeExpressionBinding} from '../../preview/core/native-expression.js';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const out=path.join(root,'outputs/native-complete-20261022');
const manifest=JSON.parse(fs.readFileSync(path.join(out,'manifest.json')));
let rawFiles=0,rawBytes=0;
for(const row of [...manifest.clips,...manifest.resources])for(const file of row.rawFiles??[]){
  const bytes=fs.readFileSync(path.join(out,'raw',row.id,file.name));
  if(bytes.length!==file.bytes||createHash('sha256').update(bytes).digest('hex')!==file.sha256)throw Error(`Original package integrity mismatch: ${row.id}/${file.name}`);
  rawFiles++;rawBytes+=bytes.length;
}
if(process.argv.includes('--integrity-only')){
  const result={packages:manifest.clips.length+manifest.resources.length,rawFiles,rawBytes,verified:true};
  fs.writeFileSync(path.join(out,'raw-integrity.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));process.exit(0);
}
const pmxBytes=fs.readFileSync(path.join(root,'assets/Aemeath/鸣潮_爱弥斯1.05.pmx'));
const pmx=new Parser().parsePmx(pmxBytes.buffer.slice(pmxBytes.byteOffset,pmxBytes.byteOffset+pmxBytes.byteLength),true);
const mesh=new THREE.SkinnedMesh(new THREE.BufferGeometry(),new THREE.MeshBasicMaterial());
const bones=pmx.bones.map(b=>{const bone=new THREE.Bone();bone.name=b.name;bone.position.fromArray(b.position);return bone;});
for(let i=0;i<bones.length;i++){
  const parent=pmx.bones[i].parentIndex;
  if(parent>=0){bones[i].position.sub(new THREE.Vector3(...pmx.bones[parent].position));bones[parent].add(bones[i]);}else mesh.add(bones[i]);
}
mesh.updateMatrixWorld(true);mesh.bind(new THREE.Skeleton(bones));
const rest=bones.map(b=>({p:b.position.clone(),q:b.quaternion.clone(),s:b.scale.clone()}));
const reset=()=>{for(let i=0;i<bones.length;i++){bones[i].position.copy(rest[i].p);bones[i].quaternion.copy(rest[i].q);bones[i].scale.copy(rest[i].s);}mesh.updateMatrixWorld(true);};
const results=[],failures=[],archived=manifest.clips.filter(r=>r.status!=='ready');
let transforms=0;
for(const row of manifest.clips.filter(r=>r.status==='ready')){
  try{
    const data=JSON.parse(gunzipSync(fs.readFileSync(path.join(out,row.file)))),clip=new NativeClip(data);
    transforms+=data.frameCount*data.bones.length;
    const singlePose=data.frameCount===1;let maxLengthError=0,mapped=0,finite=true;
    if(row.resourceKind==='body'){
      reset();const retarget=new NativeRetarget(clip,mesh);mapped=retarget.mapping.length;
      for(const t of [0,.25,.5,.75,1]){
        clip.sample(data.duration*t);retarget.apply();const snapshot=retarget.snapshot();
        finite&&=Object.values(snapshot.bones).flat().every(Number.isFinite);maxLengthError=Math.max(maxLengthError,snapshot.maxLengthError);
      }
      if(!finite||maxLengthError>1e-6)throw Error('Target contains nonfinite transforms or changed bone lengths');
    }else for(const t of [0,.5,1])clip.sample(data.duration*t);
    let maxPositionDelta=0,maxRotationDelta=0;
    for(let i=0;i<clip.local.length;i++){
      maxPositionDelta=Math.max(maxPositionDelta,clip.frames[0][i].p.distanceTo(clip.frames.at(-1)[i].p));
      maxRotationDelta=Math.max(maxRotationDelta,clip.frames[0][i].q.angleTo(clip.frames.at(-1)[i].q));
    }
    results.push({id:row.id,kind:row.resourceKind,frames:data.frameCount,bones:data.bones.length,duration:data.duration,singlePose,mapped,finite,maxLengthError,maxPositionDelta,maxRotationDelta,bakedAdditive:Boolean(data.additiveBakedToFullPose)});
  }catch(error){failures.push({id:row.id,error:error.message});}
  if((results.length+failures.length)%25===0)console.log(`Validated ${results.length} clips, ${failures.length} failures`);
  global.gc?.();
}
const dictionary=Object.fromEntries(pmx.morphs.map((m,i)=>[m.name,i])),binding=new NativeExpressionBinding(dictionary),face=[];
for(const row of manifest.resources.filter(r=>['expression','default-face','mouth'].includes(r.kind))){
  try{
    const expression=new NativeExpression(JSON.parse(fs.readFileSync(path.join(out,row.file))));
    const mapping=expression.data.curves.map(curve=>({name:curve.name,target:binding.resolve(curve.name)})),unknown=mapping.filter(r=>!r.target).map(r=>r.name);
    for(const t of [0,.25,.5,.75,1])if(!Object.values(expression.sample(t*expression.duration)).every(Number.isFinite))throw Error('Nonfinite curve sample');
    face.push({id:row.id,kind:row.kind,curves:expression.data.curves.length,mapped:mapping.filter(r=>r.target).length,unknown});
  }catch(error){failures.push({id:row.id,error:error.message});}
}
const summary={clips:results.length,body:results.filter(r=>r.kind==='body').length,sourceTransforms:transforms,bodyPoseSamples:results.filter(r=>r.kind==='body').length*5,singlePoses:results.filter(r=>r.singlePose).length,bakedAdditive:results.filter(r=>r.bakedAdditive).length,faces:face.length,failures:failures.length,archived:archived.length,rawFiles,rawBytes};
fs.writeFileSync(path.join(out,'complete-offline-audit.json'),JSON.stringify({schema:1,summary,clips:results,face,failures,archived},null,2));
console.log(JSON.stringify(summary));if(failures.length){console.log(failures);process.exitCode=1;}
