import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../preview/node_modules/three/build/three.module.js';
import {NativeBehaviorPlayer,nativePoseVelocity} from '../preview/core/native-behavior.js';
import {NATIVE_GROUPS,resolveNativePerformance} from '../realtime/character-center/native-contracts.mjs';
const pose=x=>[{p:new THREE.Vector3(x,0,0),q:new THREE.Quaternion(),s:new THREE.Vector3(1,1,1)}];
const lifecycle={entrySupport:'standing',exitSupport:'standing',contactMode:'standing',exit:'return-entry',cancel:'return-entry',returnSeconds:.65};
const make=extra=>new NativeBehaviorPlayer({initialPose:pose(3),plan:[{id:'start',phase:'start',duration:1},{id:'loop',phase:'loop',duration:1}],sample:(_,t)=>pose(t),lifecycle,...extra});
test('missing End returns from displayed position and velocity, never substitutes a foreign source End',()=>{
  const p=make(),h=1e-5;p.advance(2-h);const before=p.pose();p.advance(h);const edge=p.pose();p.advance(h);const after=p.pose();
  assert.equal(p.state,'returning');assert.equal(p.snapshot().phase,'return');
  assert.ok(nativePoseVelocity(before,edge,h)[0].p.distanceTo(nativePoseVelocity(edge,after,h)[0].p)<.01);
  p.advance(.65);assert.equal(p.state,'complete-held');assert.ok(p.pose()[0].p.distanceTo(pose(3)[0].p)<1e-8);
  assert.equal(p.snapshot().terminalRoute,'return-entry');assert.equal(p.snapshot().routeComplete,true);assert.equal(p.snapshot().supportVerified,false);
});
test('cancellation waits for a declared source boundary, skips remaining repeats and does not resurrect',()=>{
  const p=make({repeat:5});p.advance(1.4);const at=p.pose()[0].p.clone();p.cancel();assert.equal(p.state,'cancel-exit-pending');assert.ok(p.pose()[0].p.distanceTo(at)<1e-12);
  p.advance(.61);assert.equal(p.state,'cancel-returning');p.advance(1);assert.equal(p.state,'cancelled-held');assert.equal(p.events.filter(e=>e.type==='phase'&&e.phase==='loop').length,1);
  assert.equal(p.cancel().accepted,false);
});
test('same-source End is a declared route distinct from generic numerical stopping',()=>{
  const options={initialPose:pose(0),plan:[{id:'a',phase:'start',duration:1},{id:'b',phase:'loop',duration:1},{id:'c',phase:'end',duration:1}],sample:(_,t)=>pose(t)};
  const p=new NativeBehaviorPlayer({...options,lifecycle:{...lifecycle,exit:'source-end',cancel:'phase-boundary-end'}});p.advance(.3);p.cancel();p.advance(.8);assert.equal(p.currentPlan().id,'c');p.advance(2);
  assert.equal(p.snapshot().terminalRoute,'source-end');assert.equal(p.snapshot().routeComplete,true);
  const old=new NativeBehaviorPlayer(options);old.advance(5);assert.equal(old.snapshot().terminalRoute,'bounded-kinematic-stop');assert.equal(old.snapshot().routeComplete,false);
});
test('moving return needs an explicit attained-root/foot resolver and preserves that endpoint',()=>{
  assert.throws(()=>make({lifecycle:{...lifecycle,contactMode:'root-motion'}}),/attained-root/);
  const p=make({lifecycle:{...lifecycle,contactMode:'root-motion'},resolveReturnPose:({current})=>pose(current[0].p.x)});p.advance(2);const attained=p.pose()[0].p.x;p.advance(1);assert.equal(p.pose()[0].p.x,attained);assert.notEqual(attained,3);
});
test('a moving single finishes its actual source on cancel instead of freezing midstep',()=>{
  const p=make({plan:[{id:'single',phase:'single',duration:2}],lifecycle:{...lifecycle,exit:'source-complete',cancel:'finish-source',contactMode:'root-motion'}});p.advance(.4);p.cancel();p.advance(.5);assert.equal(p.state,'cancel-exit-pending');p.advance(2);assert.equal(p.state,'cancelled-held');assert.equal(p.snapshot().terminalRoute,'source-complete');
});

test('low and high permitted duration choices execute their declared cycle count without changing entry or exit clocks',()=>{
  const definition=NATIVE_GROUPS['native:thinking01'];
  for(const choice of [0,1]){
    const planned=resolveNativePerformance(definition,{total_seconds:[6,15]},{durationChoice:choice});
    const samples=[];
    const player=new NativeBehaviorPlayer({initialPose:pose(0),plan:planned.phaseData,repeat:planned.repeat,lifecycle:definition.lifecycle,sample:(id,t)=>{samples.push({id,t});return pose(Math.sin(t)*.01);}});
    player.advance(planned.actualSeconds-1e-5);assert.notEqual(player.state,'complete-held');
    player.advance(2e-5);assert.equal(player.state,'complete-held');
    assert.equal(player.events.filter(e=>e.type==='phase'&&e.phase==='start').length,1);
    assert.equal(player.events.filter(e=>e.type==='phase'&&e.phase==='loop').length,planned.repeat);
    assert.equal(player.events.filter(e=>e.type==='phase'&&e.phase==='end').length,1);
    for(const phase of definition.phaseData)assert.ok(samples.some(s=>s.id===phase.id&&Math.abs(s.t-phase.duration)<1e-7),'did not sample actual source end: '+phase.id);
  }
});
