import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {gunzipSync} from 'node:zlib';
import * as THREE from '../preview/node_modules/three/build/three.module.js';
import {parseSourceGLB,parseTargetPMX} from '../scripts/action-preparation/validate-native-behaviors.mjs';
import {NativeBehaviorAdapter} from '../preview/core/native-behavior-adapter.js';
import {NativeBehaviorPlayer,captureNativePose,applyNativePose,cloneNativePose} from '../preview/core/native-behavior.js';
import {FullBodyController} from '../preview/core/full-body-controller.js';
import {MotionRig,skeletonFromMesh} from '../preview/studio/motion-rig.js';
import {createActivityProps} from '../realtime/activities/props.mjs';
import {createNativeSceneDriver} from '../realtime/character-center/native-scene-driver.mjs';
import {NATIVE_GROUPS,resolveNativePerformance,CHARACTER_CATALOG} from '../realtime/character-center/catalog.mjs';
import {verifyNativePayload} from '../realtime/character-center/native-source-verification.mjs';
import crypto from 'node:crypto';

const checkout=process.env.FACE_RESOURCE_CHECKOUT;
const enabled=!!checkout&&fs.existsSync(path.join(checkout,'outputs/native-complete-20261022/manifest.json'));
const samePose=(a,b)=>a.every((r,i)=>r.p.distanceTo(b[i].p)<1e-8&&r.q.toArray().every((v,k)=>Math.abs(v-b[i].q.toArray()[k])<1e-8)&&r.s.distanceTo(b[i].s)<1e-8);
function fixture(){
  const outputs=path.join(checkout,'outputs'),directory=path.join(outputs,'native-complete-20261022');
  const manifest=JSON.parse(fs.readFileSync(path.join(directory,'manifest.json')));
  const source=parseSourceGLB(fs.readFileSync(path.join(outputs,'native-motion-20261022/source-mesh/Client/Content/Aki/Character/Role/FemaleM/Aimisi/R2T1AimisiMd10011/Model/R2T1AimisiMd10011.glb')));
  const {mesh}=parseTargetPMX(fs.readFileSync(path.join(checkout,'assets/Aemeath/鸣潮_爱弥斯1.05.pmx')));
  const skeleton=skeletonFromMesh(mesh),body=new FullBodyController({skeleton}),motionRig=new MotionRig(mesh);
  const scene=new THREE.Scene(),avatarRoot=new THREE.Group();avatarRoot.add(mesh);scene.add(avatarRoot,source);
  const adapter=new NativeBehaviorAdapter({mesh,source,manifest}),props=createActivityProps(scene),byName=new Map(mesh.skeleton.bones.map(b=>[b.name,b]));
  const read=async id=>{const bytes=gunzipSync(fs.readFileSync(path.join(directory,manifest.clips.find(r=>r.id===id).file)));return verifyNativePayload(bytes,crypto.createHash('sha256').update(bytes).digest('hex'));};
  function state(support='standing'){
    mesh.updateMatrixWorld(true);const bones={},rotations={};for(const [key,name] of Object.entries({pelvis:'腰',leftAnkle:'左足首',rightAnkle:'右足首'})){
      bones[key]=byName.get(name).getWorldPosition(new THREE.Vector3()).toArray();rotations[key]=byName.get(name).getWorldQuaternion(new THREE.Quaternion()).toArray();}
    return {support,hands:'free',seatSupported:support==='seated',bones,rotations,contacts:{L:true,R:true},root:structuredClone(body.root),props:props.snapshot().props};
  }
  function displayBody(){adapter.resetBind();motionRig.apply(body.locals);avatarRoot.position.set(...body.root.position);avatarRoot.rotation.y=body.root.yaw;avatarRoot.updateMatrixWorld(true);}
  displayBody();props.update({chair:true,table:true,laptop:true},{root:body.root,anchor:body.anchor,pose:body.pose,time:0});
  const driver=createNativeSceneDriver({mesh,source,nativeAdapter:adapter,body,byName,skeleton,avatarRoot,getProps:()=>props});
  return {mesh,source,body,props,adapter,read,driver,state,displayBody};
}

test('real-asset incremental async loading preserves displayed pose, loaded groups, and atomic rollback',{skip:!enabled},async()=>{
  const f=fixture(),ids=['aimisi-stand01','aimisi-thinking01-start','aimisi-thinking01-loop'];
  await f.adapter.load([ids[0]],f.read);f.adapter.apply(f.adapter.sample(ids[0],.7));const shown=captureNativePose(f.adapter.nodes),original=f.adapter.rows.get(ids[0]);
  let release;const gate=new Promise(resolve=>{release=resolve;});const waiting=f.adapter.load([ids[1]],async id=>{await gate;return f.read(id);});
  await new Promise(resolve=>setTimeout(resolve,0));assert.ok(samePose(shown,captureNativePose(f.adapter.nodes)));release();
  await Promise.all([waiting,f.adapter.load([ids[2]],f.read)]);assert.ok(samePose(shown,captureNativePose(f.adapter.nodes)));assert.equal(f.adapter.rows.get(ids[0]),original);
  const count=f.adapter.rows.size;
  await assert.rejects(f.adapter.load(['aimisi-thinking01-end'],async()=>({schema:99})),/Unsupported/);
  assert.equal(f.adapter.rows.size,count);assert.ok(samePose(shown,captureNativePose(f.adapter.nodes)));
});

test('real PMX native standing/seated preflight leaves display intact and produces measured terminal support',{skip:!enabled},async()=>{
  const f=fixture();
  for(const name of ['Stand01','Thinking01','SitTalk01']){
    const def=Object.values(NATIVE_GROUPS).find(d=>d.sourceFamily.endsWith('/'+name));await f.adapter.load(def.phases,f.read);
    if(def.lifecycle.entrySupport==='seated'){
      f.body.play('sit_down');for(let i=0;i<200&&!f.body.done;i++)f.body.update(i*.05,.05);f.displayBody();
    }else {f.body.pose=f.body.standing(f.body.root);f.body.solve();f.displayBody();}
    const before=captureNativePose(f.adapter.nodes),plan=def.phaseData,prepared=f.driver.preparePlan(def,plan,f.state(def.lifecycle.entrySupport));
    assert.ok(samePose(before,captureNativePose(f.adapter.nodes)),'preflight changed display');assert.equal(prepared.accepted,true,name+': '+prepared.reason);
    const player=new NativeBehaviorPlayer({plan,sample:f.driver.sample,align:f.driver.align,initialPose:before,lifecycle:def.lifecycle,resolveReturnPose:f.driver.resolveReturnPose});
    for(let t=0;t<def.duration+1;t+=.05){player.advance(.05);f.adapter.apply(player.pose());}
    const terminal=f.driver.validateTerminal(player.snapshot());assert.equal(terminal.ok,true,name+': '+JSON.stringify(terminal));
  }
});

test('cooperative real-target preflight yields without taking ownership and revalidates the prepared scene',{skip:!enabled},async()=>{
  const f=fixture(),def=NATIVE_GROUPS['native:stand01'];await f.adapter.load(def.phases,f.read);
  const displayed=captureNativePose(f.adapter.nodes),state=f.state();let yields=0;
  const timer=setInterval(()=>{yields++;assert.ok(samePose(displayed,captureNativePose(f.adapter.nodes)),'preflight exposed a sampled pose between slices');},0);
  let prepared;try{prepared=await f.driver.preparePlanAsync(def,def.phaseData,state);}finally{clearInterval(timer);}
  assert.equal(prepared.accepted,true,prepared.reason);assert.ok(yields>2);assert.equal(f.driver.snapshot().activeId,null);
  const moved=structuredClone(state);moved.bones.pelvis[0]+=.5;
  assert.equal(f.driver.activatePrepared(prepared,moved).reason,'native_prepared_scene_changed');
  for(const [label,change] of [
    ['root facing',next=>{next.root.yaw+=.2;}],
    ['table rotation',next=>{next.props.table.quaternion=new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,1,0),.2).toArray();}],
    ['chair scale',next=>{next.props.chair.scale[0]*=1.1;}],
    ['laptop lid',next=>{next.props.laptop.openness=(next.props.laptop.openness??1)-.2;}],
  ]) {
    const changed=structuredClone(state);change(changed);
    assert.equal(f.driver.activatePrepared(prepared,changed).reason,'native_prepared_scene_changed',label);
    assert.equal(f.driver.snapshot().activeId,null,label+' acquired a stale physical plan');
  }
  assert.equal(f.driver.snapshot().activeId,null);
  assert.equal(f.driver.activatePrepared(prepared,state).accepted,true);
  assert.equal(f.driver.snapshot().activeId,def.id);
  let checks=0;const cancelled=await f.driver.preparePlanAsync(def,def.phaseData,state,{isCurrent:()=>++checks<3});
  assert.equal(cancelled.reason,'native_preparation_cancelled');assert.ok(samePose(displayed,captureNativePose(f.adapter.nodes)));
  const successor=cloneNativePose(displayed),waist=f.adapter.nodes.findIndex(node=>node.name==='腰');
  assert.ok(waist>=0);successor[waist].q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,1,0),.1));
  let newestDisplay,validityChecks=0;
  const interrupted=await f.driver.preparePlanAsync(def,def.phaseData,state,{isCurrent:()=>{
    if(++validityChecks===2){f.adapter.apply(successor);newestDisplay=captureNativePose(f.adapter.nodes);return false;}
    return true;
  }});
  assert.equal(interrupted.reason,'native_preparation_cancelled');
  assert.ok(samePose(newestDisplay,captureNativePose(f.adapter.nodes)),'cancelled preflight restored an older frame over its successor');
});

test('both distinct Thinking02 loop variants keep their full source entry/exit, complete after three cycles and cancel on the real route',{skip:!enabled},async()=>{
  const f=fixture(),def=Object.values(NATIVE_GROUPS).find(d=>d.sourceFamily.endsWith('/Thinking02'));await f.adapter.load(def.phases,f.read);
  for(const variant of def.performanceContract.variant_set.filter(id=>id.startsWith('phase:'))){
    f.body.reset();f.displayBody();const initial=captureNativePose(f.adapter.nodes),planned=resolveNativePerformance(def,{variant_set:[variant]});
    const prepared=f.driver.preparePlan(def,planned.phaseData,f.state());assert.equal(prepared.accepted,true,prepared.reason);
    const plan=prepared.plan??planned.phaseData,loop=plan.find(p=>p.phase==='loop'),source=plan.reduce((n,p)=>n+p.duration,0);
    const seconds=source+loop.duration*2+def.durationContract.returnSeconds+def.durationContract.settleSeconds;
    const create=()=>new NativeBehaviorPlayer({plan,repeat:3,sample:f.driver.sample,align:f.driver.align,initialPose:initial,lifecycle:def.lifecycle,resolveReturnPose:f.driver.resolveReturnPose});
    const player=create();player.advance(seconds-1e-5);assert.notEqual(player.state,'complete-held');player.advance(2e-5);f.adapter.apply(player.pose());
    assert.equal(player.state,'complete-held');assert.equal(f.driver.validateTerminal(player.snapshot()).ok,true);
    const cancel=create(),entry=plan.slice(0,plan.indexOf(loop)).reduce((n,p)=>n+p.duration,0);cancel.advance(entry+loop.duration*.5);const before=cloneNativePose(cancel.pose());cancel.cancel();
    assert.ok(samePose(before,cancel.pose()));cancel.advance(seconds);f.adapter.apply(cancel.pose());assert.equal(f.driver.validateTerminal(cancel.snapshot()).ok,true);
    assert.equal(cancel.events.filter(e=>e.type==='phase'&&e.phase==='loop').length,1,'cancel replayed an unrequested remaining loop');
  }
});

test('native travel refuses an actual table in its route and accepts the same source on clear ground',{skip:!enabled},async()=>{
  const f=fixture(),def=Object.values(NATIVE_GROUPS).find(d=>d.sourceFamily.endsWith('/fuyong/Walk_F'));await f.adapter.load(def.phases,f.read);
  const before=captureNativePose(f.adapter.nodes),blocked=f.driver.preparePlan(def,def.phaseData,f.state());
  assert.equal(blocked.accepted,false);assert.match(blocked.reason,/native_route_blocked_by_/);assert.ok(samePose(before,captureNativePose(f.adapter.nodes)));
  f.props.clear();const clear=f.driver.preparePlan(def,def.phaseData,f.state());assert.equal(clear.accepted,true,clear.reason);
});

test('Weak_Sit starts in front of the pulled-out actual chair and keeps reachable foot support through the full source',{skip:!enabled},async()=>{
  const f=fixture(),def=NATIVE_GROUPS['native:a5508661ae29831d'];await f.adapter.load(def.phases,f.read);
  f.body.root={position:[0,0,-2.594705891609191],yaw:0};f.body.anchor=structuredClone(f.body.root);f.body.pose=f.body.standing(f.body.root);f.body.solve();f.displayBody();
  f.props.clear();f.props.update({chair:{visible:true,attachment:'floor',worldTransform:{position:[0,0,-8.2],quaternion:[0,0,0,1]}}},{root:f.body.root,anchor:f.body.anchor,pose:f.body.pose,time:0});
  const initial=captureNativePose(f.adapter.nodes),prepared=f.driver.preparePlan(def,def.phaseData,f.state());
  assert.equal(prepared.accepted,true,JSON.stringify(prepared));
  const plan=prepared.plan??def.phaseData,player=new NativeBehaviorPlayer({plan,sample:f.driver.sample,align:f.driver.align,initialPose:initial,lifecycle:def.lifecycle,resolveReturnPose:f.driver.resolveReturnPose});
  let seated=false;
  for(let t=0;t<def.duration+.1;t+=1/60){try{player.advance(1/60);}catch(error){error.message+=' at sourceTime '+t;throw error;}f.adapter.apply(player.pose());const evidence=f.driver.measureState(player.snapshot());seated ||=evidence.seatSupported;}
  assert.ok(seated,'never reached the actual chair');assert.equal(f.driver.validateTerminal(player.snapshot()).ok,true);
  const cancellations=[];
  for(const time of [2,8.5,10.8]){
    const cancelled=new NativeBehaviorPlayer({plan,sample:f.driver.sample,align:f.driver.align,initialPose:initial,lifecycle:def.lifecycle,resolveReturnPose:f.driver.resolveReturnPose});
    cancelled.advance(time);const before=cloneNativePose(cancelled.pose());cancelled.cancel();assert.ok(samePose(before,cancelled.pose()));
    for(let t=time;t<def.duration+1;t+=1/60){cancelled.advance(1/60);f.adapter.apply(cancelled.pose());}
    const terminal=f.driver.validateTerminal(cancelled.snapshot());assert.equal(terminal.ok,true);cancellations.push({at:time,terminal,player:cancelled.snapshot()});
  }
  const report={id:def.id,at:new Date().toISOString(),catalogHash:CHARACTER_CATALOG.hash,driverSha256:crypto.createHash('sha256').update(fs.readFileSync(new URL('../realtime/character-center/native-scene-driver.mjs',import.meta.url))).digest('hex'),affectedNativeIds:Object.values(NATIVE_GROUPS).filter(d=>d.lifecycle.contactMode==='root-motion'&&(d.lifecycle.middleSupport==='seated'||d.requires.props.includes('chair'))).map(d=>d.id),fixture:{root:[0,0,-2.594705891609191],chair:[0,0,-8.2],onlyChairVisible:true},sampleRate:60,sourceSeconds:def.durationContract.sourceSeconds,
    sourceAmplitude:1,sourceSpeed:1,preparation:prepared.diagnostics,actualSeatReached:seated,complete:f.driver.validateTerminal(player.snapshot()),cancellations,passed:true};
  fs.mkdirSync(new URL('../outputs/library-expansion/',import.meta.url),{recursive:true});
  fs.writeFileSync(new URL('../outputs/library-expansion/native-weak-seat-fixture.json',import.meta.url),JSON.stringify(report,null,2)+'\n');
});

test('Sit01 source End finishes with actual floor support from the pulled-out chair fixture',{skip:!enabled},async()=>{
  const f=fixture(),def=NATIVE_GROUPS['native:025acfb4d0c464f4'];
  f.body.root={position:[0,0,-2.594705891609191],yaw:0};f.body.anchor=structuredClone(f.body.root);f.body.pose=f.body.standing(f.body.root);f.body.solve();f.displayBody();
  f.props.clear();f.props.update({chair:{visible:true,attachment:'floor',worldTransform:{position:[0,0,-8.2],quaternion:[0,0,0,1]}}},{root:f.body.root,anchor:f.body.anchor,pose:f.body.pose,time:0});
  await f.adapter.load(def.phases,f.read);
  const initial=captureNativePose(f.adapter.nodes),prepared=f.driver.preparePlan(def,def.phaseData,f.state());assert.equal(prepared.accepted,true,JSON.stringify(prepared));
  const cases=[];
  for(const dt of [1/60,.1])for(const cancelAt of [null,1.5,5,9.5]){
    const player=new NativeBehaviorPlayer({plan:prepared.plan??def.phaseData,sample:f.driver.sample,align:f.driver.align,initialPose:initial,bridgeSeconds:.45,stopOptions:f.adapter.stopOptions(),lifecycle:def.lifecycle,resolveReturnPose:f.driver.resolveReturnPose});
    let cancelled=false;
    for(let t=0;t<def.duration+.2;t+=dt){player.advance(dt);f.adapter.apply(player.pose());if(cancelAt!==null&&!cancelled&&player.time>=cancelAt){const before=cloneNativePose(player.pose());player.cancel();assert.ok(samePose(before,player.pose()),'cancel changed the displayed frame');cancelled=true;}}
    const terminal=f.driver.validateTerminal(player.snapshot());assert.equal(terminal.ok,true,JSON.stringify({dt,cancelAt,terminal,actor:f.state()}));
    assert.equal(player.state,cancelAt===null?'complete-held':'cancelled-held');cases.push({dt,cancelAt,terminal,player:player.snapshot()});
  }
  fs.writeFileSync(new URL('../outputs/library-expansion/native-sit01-seat-fixture.json',import.meta.url),JSON.stringify({at:new Date().toISOString(),id:def.id,catalogHash:CHARACTER_CATALOG.hash,fixture:{root:[0,0,-2.594705891609191],chair:[0,0,-8.2],onlyChairVisible:true,loadAfterPlacement:true},cases,passed:true},null,2)+'\n');
});

test('all 109 native groups calibrate identically when lazy-loaded after actor translation and facing change',{skip:!enabled},async()=>{
  const canonical=fixture(),placed=fixture();
  placed.body.root={position:[3,0,-7],yaw:.8};placed.body.pose=placed.body.standing(placed.body.root);placed.body.solve();placed.displayBody();
  const original=captureNativePose(placed.adapter.nodes),families=Object.values(NATIVE_GROUPS),ids=[...new Set(families.flatMap(row=>row.phases))];
  let maxPositionError=0,maxRotationError=0;
  for(const id of ids){
    await canonical.adapter.load([id],canonical.read);await placed.adapter.load([id],placed.read);
    assert.ok(samePose(original,captureNativePose(placed.adapter.nodes)),id+': lazy load changed display');
    const a=canonical.adapter.rows.get(id).retarget,b=placed.adapter.rows.get(id).retarget;
    assert.equal(a.scale,b.scale,id+': calibration scale');
    maxPositionError=Math.max(maxPositionError,a.pelvisOffset.distanceTo(b.pelvisOffset));
    for(const [name,r] of a.rest){const s=b.rest.get(name);maxPositionError=Math.max(maxPositionError,r.wp.distanceTo(s.wp));maxRotationError=Math.max(maxRotationError,...r.wq.toArray().map((v,i)=>Math.abs(v-s.wq.toArray()[i])));}
    assert.ok(maxPositionError<1e-10&&maxRotationError<1e-10,id+': scene position contaminated bind calibration');
    // This is a per-source invariant test, not a preload-all cache benchmark.
    // Keep at most the currently compared pair of decoded source clips alive.
    canonical.adapter.rows.clear();placed.adapter.rows.clear();
  }
  const report={at:new Date().toISOString(),catalogHash:CHARACTER_CATALOG.hash,groups:families.length,phases:ids.length,sourceGroups:families.map(row=>row.id),sceneTransform:{position:[3,0,-7],yaw:.8},maxPositionError,maxRotationError,
    adapterSha256:crypto.createHash('sha256').update(fs.readFileSync(new URL('../preview/core/native-behavior-adapter.js',import.meta.url))).digest('hex'),
    evidence:'Every approved source phase has identical model-space bind calibration at origin and after actual parent translation/yaw; display preserved. This does not rerun full geometry or browser playback for 109 groups.',passed:true};
  fs.mkdirSync(new URL('../outputs/library-expansion/',import.meta.url),{recursive:true});fs.writeFileSync(new URL('../outputs/library-expansion/native-load-calibration-invariance.json',import.meta.url),JSON.stringify(report,null,2)+'\n');
});
