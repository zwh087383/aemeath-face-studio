import test from 'node:test';
import {motionExclusionFor} from '../preview/core/character-motion-policy.js';
import assert from 'node:assert/strict';
import * as THREE from '../preview/node_modules/three/build/three.module.js';
import {NativeBehaviorPlayer,NativePoseBridge,NativePoseStop,nativePoseVelocity} from '../preview/core/native-behavior.js';
import {buildNativeBehaviorPlan} from '../preview/core/native-behavior-adapter.js';
import fs from 'node:fs';
const pose=(x=0,angle=0,axis=new THREE.Vector3(0,1,0))=>[{p:new THREE.Vector3(x,0,0),q:new THREE.Quaternion().setFromAxisAngle(axis,angle),s:new THREE.Vector3(1,1,1)}];
const maxDiff=(a,b)=>Math.max(a[0].p.distanceTo(b[0].p),a[0].q.angleTo(b[0].q),a[0].s.distanceTo(b[0].s));
test('bridge retains a moving pose and angular tangent even across different axes',()=>{
  const h=1e-6,current=pose(2,1.4,new THREE.Vector3(1,0,0)),currentNext=pose(2+3*h,1.4,new THREE.Vector3(1,0,0));currentNext[0].q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,0,1),2*h));
  const incoming=pose(0,-.8),incomingNext=pose(-h,-.8+1.1*h),v=nativePoseVelocity(current,currentNext,h);
  const bridge=new NativePoseBridge({current,velocity:v,incoming,incomingFuture:incomingNext,derivativeStep:h,duration:.5});
  assert.ok(maxDiff(current,bridge.apply(incoming,0))<1e-7);
  const outV=nativePoseVelocity(bridge.apply(incoming,0),bridge.apply(incomingNext,h),h);
  assert.ok(outV[0].p.distanceTo(v[0].p)<1e-3);assert.ok(outV[0].q.distanceTo(v[0].q)<1e-3);
  assert.ok(maxDiff(incoming,bridge.apply(incoming,.5))<1e-7);
});
test('bounded stop starts with the outgoing velocity, ends still, and stays at its own endpoint',()=>{
  const h=1e-6,current=pose(7,1),velocity=[{p:new THREE.Vector3(2,0,0),q:new THREE.Vector3(0,3,0),s:new THREE.Vector3()}],stop=new NativePoseStop(current,velocity);
  const observed=nativePoseVelocity(stop.sample(0),stop.sample(h),h);assert.ok(observed[0].p.distanceTo(velocity[0].p)<1e-3);assert.ok(observed[0].q.distanceTo(velocity[0].q)<1e-3);
  assert.ok(maxDiff(stop.sample(stop.duration),stop.sample(stop.duration+10))<1e-7);assert.ok(stop.sample(10)[0].p.x>7);
});
test('explicit clock pause, deterministic seek, repeated cancellation and stale epochs',()=>{
  const p=new NativeBehaviorPlayer({plan:[{id:'move',phase:'single',duration:2}],sample:(_,t)=>pose(t,t*.4),initialPose:pose()});
  p.advance(.63);const before=p.pose();p.pause();p.advance(1);assert.equal(p.time,.63);assert.ok(maxDiff(p.pose(),before)<1e-8);p.pause(false);
  const previous=p.epoch;p.seek(.63);assert.ok(maxDiff(p.pose(),before)<1e-7);assert.equal(p.cancel({epoch:previous}).accepted,false);
  assert.equal(p.cancel().accepted,true);assert.equal(p.cancel().accepted,false);p.advance(2);assert.equal(p.state,'cancelled-held');assert.ok(p.pose()[0].p.x>.6);assert.ok(p.pose()[0].p.x<1.2);
});
test('same-source phase plan rejects a borrowed End from another directory',()=>{
  const row={id:'a',resourceKind:'body',status:'ready',sourceAsset:'A/Foo_Start.uasset',duration:1};
  const g={kind:'native-body-family',sourceFamily:'A/Foo',memberIds:['a'],sources:[{id:'a',phase:'start',sourceRef:row.sourceAsset}]};
  assert.equal(buildNativeBehaviorPlan(g,{clips:[row]})[0].id,'a');
  const alien={...row,sourceAsset:'B/Foo_Start.uasset'};assert.throws(()=>buildNativeBehaviorPlan({...g,sources:[{...g.sources[0],sourceRef:alien.sourceAsset}]},{clips:[alien]}),/Foreign/);
});
test('crossing a moving phase boundary preserves actual pose and local velocity',()=>{
  const h=1e-5,p=new NativeBehaviorPlayer({plan:[{id:'a',phase:'start',duration:1},{id:'b',phase:'end',duration:1}],sample:(id,t)=>id==='a'?pose(t,t):pose(-2+t,1+.3*t),initialPose:pose()});
  p.advance(1-h);const a=p.pose();p.advance(h);const b=p.pose();p.advance(h);const c=p.pose();
  const left=nativePoseVelocity(a,b,h),right=nativePoseVelocity(b,c,h);assert.ok(left[0].p.distanceTo(right[0].p)<.01);assert.ok(left[0].q.distanceTo(right[0].q)<.01);
});
test('same-source End cancellation is explicit preview and never implies automatic approval',()=>{
  const p=new NativeBehaviorPlayer({plan:[{id:'a',phase:'start',duration:2},{id:'b',phase:'end',duration:1}],sample:(_,t)=>pose(t,t),initialPose:pose()});p.advance(.7);const current=p.pose();p.cancel({useEnd:true});assert.ok(maxDiff(current,p.pose())<1e-7);assert.equal(p.currentPlan().id,'b');assert.equal(p.snapshot().automaticEligible,false);
});
test('two loop variants each receive their own repeat count, for repeat 2 and 3',()=>{
  for(const repeat of [2,3]){const p=new NativeBehaviorPlayer({repeat,plan:[{id:'a',phase:'start',duration:1},{id:'b',phase:'loop',duration:1},{id:'c',phase:'loop',duration:1},{id:'d',phase:'end',duration:1}],sample:(_,t)=>pose(t*.1,t*.1),initialPose:pose()});p.advance(1+repeat*2+.5);const phases=p.events.filter(e=>e.type==='phase').map(e=>e.id);assert.deepEqual(phases,['a',...Array(repeat).fill('b'),...Array(repeat).fill('c'),'d']);}
});
test('a fast bounded stop never violates its declared displacement cap',()=>{
  const current=pose(),v=[{p:new THREE.Vector3(100,0,0),q:new THREE.Vector3(0,200,0),s:new THREE.Vector3()}],stop=new NativePoseStop(current,v,{duration:.4,maxRotationRadians:.3,maxPositionDistance:.2});
  assert.ok(stop.sample(10)[0].p.length()<=.2+1e-9);assert.ok(current[0].q.angleTo(stop.sample(10)[0].q)<=.3+1e-9);assert.throws(()=>new NativePoseStop(current,[{...v[0],q:new THREE.Vector3(NaN,0,0)}]),/Invalid/);
});
test('cancel during existing End reports the actual kinematic stop route',()=>{
  const p=new NativeBehaviorPlayer({plan:[{id:'a',phase:'end',duration:1}],sample:(_,t)=>pose(t,t),initialPose:pose()});p.advance(.4);p.cancel({useEnd:true});assert.equal(p.events.at(-1).route,'bounded-kinematic-stop');
});
test('entry from a moving display preserves its supplied velocity, including reset/seek',()=>{
  const h=1e-6,initialPose=pose(3,.8),initialVelocity=[{p:new THREE.Vector3(2,0,0),q:new THREE.Vector3(0,1,0),s:new THREE.Vector3()}];
  const player=new NativeBehaviorPlayer({initialPose,initialVelocity,plan:[{id:'b',phase:'single',duration:2}],sample:(_,t)=>pose(-2+t,-.5+t*.2)});
  for(let i=0;i<3;i++){const a=player.pose();player.advance(h);const v=nativePoseVelocity(a,player.pose(),h);assert.ok(v[0].p.distanceTo(initialVelocity[0].p)<1e-3);assert.ok(v[0].q.distanceTo(initialVelocity[0].q)<1e-3);player.seek(0);}
  assert.throws(()=>new NativeBehaviorPlayer({initialPose,initialVelocity:[],plan:[{id:'x',duration:1}],sample:()=>pose()}),/Invalid entry/);
});
test('numbered loop phases stay before End and retain their explicit variant',()=>{
  const phases=['end','loop2','start','loop1'],clips=phases.map((phase,i)=>({id:'phase-'+i,resourceKind:'body',status:'ready',sourceAsset:'A/Thinking_'+phase.replace(/^./,c=>c.toUpperCase())+'.uasset',duration:1}));
  const group={kind:'native-body-family',sourceFamily:'A/Thinking',memberIds:clips.map(c=>c.id),sources:clips.map((c,i)=>({id:c.id,sourceRef:c.sourceAsset,phase:phases[i]}))};
  const plan=buildNativeBehaviorPlan(group,{clips});assert.deepEqual(plan.map(p=>p.sourcePhase),['start','loop1','loop2','end']);assert.deepEqual(plan.map(p=>p.phase),['start','loop','loop','end']);
});
test('current private catalog preserves all source records while only reviewed groups become plans',{skip:!fs.existsSync(new URL('../outputs/action-preparation-20261023/review-queue.json',import.meta.url))},()=>{
  const queue=JSON.parse(fs.readFileSync(new URL('../outputs/action-preparation-20261023/review-queue.json',import.meta.url))),manifest=JSON.parse(fs.readFileSync(new URL('../outputs/native-complete-20261022/manifest.json',import.meta.url))),groups=queue.groups.filter(g=>g.kind==='native-body-family');let count=0;
  let excluded=0,archivedClips=0;
  for(const group of groups){if(motionExclusionFor(group)){excluded++;archivedClips+=group.memberIds.length;assert.throws(()=>buildNativeBehaviorPlan(group,manifest),/User-excluded motion/);continue;}const plan=buildNativeBehaviorPlan(group,manifest);count+=plan.length;const end=plan.findIndex(p=>p.phase==='end');assert.ok(end<0||plan.slice(end).every(p=>p.phase==='end'));assert.deepEqual([...plan.map(p=>p.id)].sort(),[...group.memberIds].sort());}
  assert.equal(groups.length,149);assert.equal(excluded,20);assert.equal(archivedClips,30);assert.equal(count,289);assert.equal(count+archivedClips,319);
});
