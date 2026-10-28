import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {fileURLToPath} from 'node:url';
import * as THREE from '../../preview/node_modules/three/build/three.module.js';
import {parseSourceGLB,parseTargetPMX} from '../action-preparation/validate-native-behaviors.mjs';
import {NativeBehaviorAdapter} from '../../preview/core/native-behavior-adapter.js';
import {NativeBehaviorPlayer,captureNativePose,cloneNativePose,finiteNativePose} from '../../preview/core/native-behavior.js';
import {FullBodyController} from '../../preview/core/full-body-controller.js';
import {MotionRig,skeletonFromMesh} from '../../preview/studio/motion-rig.js';
import {createActivityProps} from '../../realtime/activities/props.mjs';
import {createNativeSceneDriver} from '../../realtime/character-center/native-scene-driver.mjs';
import {NATIVE_GROUPS,CHARACTER_CATALOG} from '../../realtime/character-center/catalog.mjs';
import {verifyNativePayload} from '../../realtime/character-center/native-source-verification.mjs';

const args=process.argv.slice(2),value=key=>args[args.indexOf(key)+1],root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
if(!args.includes('--resource-checkout'))throw Error('Specify --resource-checkout; original resources are read only.');
const checkout=path.resolve(value('--resource-checkout')),outputs=path.join(checkout,'outputs'),directory=path.join(outputs,'native-complete-20261022');
const destination=path.resolve(root,args.includes('--output')?value('--output'):'outputs/library-expansion/native-target-results.json');
if(!destination.startsWith(root+path.sep))throw Error('Validation output must stay in this worktree');
const manifest=JSON.parse(fs.readFileSync(path.join(directory,'manifest.json'))),
  source=parseSourceGLB(fs.readFileSync(path.join(outputs,'native-motion-20261022/source-mesh/Client/Content/Aki/Character/Role/FemaleM/Aimisi/R2T1AimisiMd10011/Model/R2T1AimisiMd10011.glb'))),
  {mesh}=parseTargetPMX(fs.readFileSync(path.join(checkout,'assets/Aemeath/鸣潮_爱弥斯1.05.pmx')));
const skeleton=skeletonFromMesh(mesh),body=new FullBodyController({skeleton}),motionRig=new MotionRig(mesh),scene=new THREE.Scene(),avatarRoot=new THREE.Group();avatarRoot.add(mesh);scene.add(avatarRoot,source);
const adapter=new NativeBehaviorAdapter({mesh,source,manifest}),props=createActivityProps(scene),byName=new Map(mesh.skeleton.bones.map(b=>[b.name,b]));
const read=async id=>{const bytes=gunzipSync(fs.readFileSync(path.join(directory,manifest.clips.find(r=>r.id===id).file)));return verifyNativePayload(bytes,crypto.createHash('sha256').update(bytes).digest('hex'));};
const driver=createNativeSceneDriver({mesh,source,nativeAdapter:adapter,body,byName,skeleton,avatarRoot,getProps:()=>props});
function displayBody(){adapter.resetBind();motionRig.apply(body.locals);avatarRoot.position.set(...body.root.position);avatarRoot.rotation.y=body.root.yaw;avatarRoot.updateMatrixWorld(true);}
function actor(support){const bones={},rotations={};for(const [key,name] of Object.entries({pelvis:'腰',leftAnkle:'左足首',rightAnkle:'右足首'})){
  bones[key]=byName.get(name).getWorldPosition(new THREE.Vector3()).toArray();rotations[key]=byName.get(name).getWorldQuaternion(new THREE.Quaternion()).toArray();}
  return {support,hands:'free',seatSupported:support==='seated',bones,rotations,contacts:{L:true,R:true},root:structuredClone(body.root),props:props.snapshot().props};}
const report={schema:1,catalogHash:CHARACTER_CATALOG.hash,nativeCatalogSha256:crypto.createHash('sha256').update(JSON.stringify(NATIVE_GROUPS)).digest('hex'),startedAt:new Date().toISOString(),
  scope:'Actual source GLTF and target PMX skeleton. All phase boundaries and quarter points; phase-kind cancellations. No GPU/cloth-clearance or human continuous-view acceptance.',
  targetSha256:crypto.createHash('sha256').update(fs.readFileSync(path.join(checkout,'assets/Aemeath/鸣潮_爱弥斯1.05.pmx'))).digest('hex'),groups:[],failures:[]};
let selected=Object.values(NATIVE_GROUPS);if(args.includes('--names')){const names=new Set(value('--names').split(','));selected=selected.filter(d=>names.has(d.sourceFamily.split('/').at(-1)));}
if(args.includes('--exclude-passed')){const prior=JSON.parse(fs.readFileSync(path.resolve(root,value('--exclude-passed')),'utf8'));if(prior.catalogHash!==report.catalogHash||prior.targetSha256!==report.targetSha256)throw Error('Prior evidence version mismatch');const done=new Set(prior.groups.filter(g=>g.passed).map(g=>g.id));selected=selected.filter(d=>!done.has(d.id));}
if(args.includes('--shard')){const [index,count]=value('--shard').split('/').map(Number);if(!Number.isInteger(index)||!Number.isInteger(count)||index<0||index>=count||count<1)throw Error('Invalid shard');selected=selected.filter((_,i)=>i%count===index);report.shard={index,count};}
for(const def of selected){const begin=performance.now(),result={id:def.id,sourceFamily:def.sourceFamily,passed:false,sourceMatched:false,samples:[],cancellations:[]};
  try{
    // This is an isolated batch fixture, never the live application's cache.
    adapter.rows.clear();await adapter.load(def.phases,read);body.root={position:[0,0,0],yaw:0};body.anchor=structuredClone(body.root);body.pose=body.standing(body.root);body.solve();
    body.done=true;body.activeId=null;body.bridge=null;body.queued=null;body.stopMode=null;body.afterPrerequisite=null;
    displayBody();props.clear();props.update(Object.fromEntries(def.requires.props.map(id=>[id,true])),{root:body.root,anchor:body.anchor,pose:body.pose,time:0});
    if(def.lifecycle.entrySupport==='seated'){body.play('sit_down');for(let i=0;i<220&&!body.done;i++)body.update(i*.05,.05);displayBody();}
    const initial=captureNativePose(adapter.nodes),prepared=driver.preparePlan(def,def.phaseData,actor(def.lifecycle.entrySupport));result.preflight={...prepared};
    if(!prepared.accepted)throw Error(prepared.reason);result.sourceMatched=true;
    delete result.preflight.plan;const plan=prepared.plan??def.phaseData;
    const create=()=>new NativeBehaviorPlayer({plan,sample:driver.sample,align:driver.align,initialPose:initial,lifecycle:def.lifecycle,resolveReturnPose:driver.resolveReturnPose});
    let cursor=0;const sampleTimes=[];
    for(const phase of plan){for(const f of [0,.25,.5,.75,1])sampleTimes.push({time:cursor+phase.duration*f,id:phase.id,phase:phase.phase,fraction:f});cursor+=phase.duration;}
    const sampledPlayer=create();let sampledTime=0;
    for(const entry of sampleTimes){const player=sampledPlayer;player.advance(Math.max(0,entry.time-sampledTime));sampledTime=entry.time;adapter.apply(player.pose());const evidence=driver.measureState(player.snapshot());
      if(!finiteNativePose(player.pose()))throw Error('nonfinite_target');result.samples.push({...entry,support:evidence.support,seatSupported:evidence.seatSupported,contacts:evidence.contacts});}
    const complete=create();complete.advance(cursor+2);adapter.apply(complete.pose());result.terminal=driver.validateTerminal(complete.snapshot());if(!result.terminal.ok)throw Error(result.terminal.reason);
    const candidates=['start','loop','end'].map(kind=>sampleTimes.find(t=>t.phase===kind&&t.fraction===.5));
    const cancelPoints=candidates.filter(Boolean);if(!cancelPoints.length)cancelPoints.push(...[.2,.5,.8].map(f=>({time:cursor*f,phase:'single'})));
    for(const point of cancelPoints){const player=create();player.advance(point.time);const before=cloneNativePose(player.pose());player.cancel();
      const cancelPositionGap=Math.max(...before.map((p,i)=>p.p.distanceTo(player.pose()[i].p)));
      if(cancelPositionGap>1e-7)throw Error('cancel_position_jump');
      player.advance(cursor+2);adapter.apply(player.pose());const terminal=driver.validateTerminal(player.snapshot());result.cancellations.push({at:point.time,phase:point.phase,route:player.snapshot().terminalRoute,cancelPositionGap,terminal});
      if(!terminal.ok)throw Error('cancel_'+terminal.reason);}
    result.passed=true;
  }catch(error){result.reason=error.message;report.failures.push({id:def.id,sourceFamily:def.sourceFamily,reason:error.message});}
  result.elapsedMs=performance.now()-begin;report.groups.push(result);fs.mkdirSync(path.dirname(destination),{recursive:true});fs.writeFileSync(destination,JSON.stringify(report,null,2)+'\n');
  console.log(`${report.groups.length}/${selected.length} ${def.sourceFamily.split('/').at(-1)} ${result.passed?'passed':result.reason}`);
}
report.finishedAt=new Date().toISOString();report.passed=report.failures.length===0;report.coverage={requested:selected.length,completed:report.groups.length,passed:report.groups.filter(g=>g.passed).length};
fs.writeFileSync(destination,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({destination,...report.coverage,failures:report.failures.length}));if(!report.passed)process.exitCode=1;
