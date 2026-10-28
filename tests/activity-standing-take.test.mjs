import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as THREE from '../preview/node_modules/three/build/three.module.js';
import { FullBodyController } from '../preview/core/full-body-controller.js';
import { skeletonFromInspection } from '../preview/core/motion-skeleton.js';
import { ACTIVITY_LIBRARY, sampleActivity } from '../preview/core/activity-library.js';
import { PARTITIONED_DESK } from '../preview/core/activity-desk-layout.js';
import { createActivityProps } from '../realtime/activities/props.mjs';
const skeleton=skeletonFromInspection(JSON.parse(fs.readFileSync(new URL('../assets/Aemeath-inspection.json',import.meta.url),'utf8')));
const copy=x=>structuredClone(x),distance=(a,b)=>Math.hypot(...a.map((n,i)=>n-b[i]));
function fixture(setup){const c=new FullBodyController({skeleton}),props=createActivityProps(new THREE.Scene());props.update(setup,{anchor:c.anchor,root:c.root,pose:c.pose,time:0});c.setRenderedPropsSnapshot(props.snapshot());return {c,props};}
for(const id of ['take_book_standing','take_mug_standing','pickup_box'])test(`${id} uses its own gate in a partitioned scene, and an actual stationary object grants ownership`,()=>{
 const prop=ACTIVITY_LIBRARY[id].propId,setup={table:true,[prop]:prop==='box'?{visible:true,attachment:'table',position:[0,8.9,3.8]}:copy(PARTITIONED_DESK.setupProps[prop])};
 const {c,props}=fixture(setup),original=copy(props.snapshot().props[prop].position),feet=copy(c.pose.feet);
 const prepared=c.preparePlay(id,{context:{deskLayout:'partitioned'}});assert.equal(prepared.accepted,true,prepared.reason);
 assert.equal(c.play(id,prepared.options),true);let acquired=false,maximumStep=0,last=original,gateElapsed=null;
 for(let i=0;i<540&&!c.done;i++){
  c.update(c.now+1/60,1/60);const hands=c.handAnchors();props.update({...c.sceneProps,...c.pose.props},{anchors:{leftHand:hands.L,rightHand:hands.R},root:c.root,anchor:c.pose.anchor??c.anchor,pose:c.pose,snapshot:c.snapshot(),time:c.now});
  const row=props.snapshot().props[prop];
  if(!acquired){assert.ok(distance(row.position,original)<1e-8);if(row.transfer?.released){acquired=true;gateElapsed=c.elapsed;assert.ok(row.transfer.gripError<.025);}}
  maximumStep=Math.max(maximumStep,distance(row.position,last));last=copy(row.position);
  assert.ok(c.diagnostics.legs.L.error<1e-6&&c.diagnostics.legs.R.error<1e-6);
  assert.deepEqual(c.pose.feet.L.position,feet.L.position);assert.deepEqual(c.pose.feet.R.position,feet.R.position);
  c.setRenderedPropsSnapshot(props.snapshot());c.setPropTransferReceipts(props.snapshot());
 }
 assert.equal(acquired,true);assert.equal(c.done,true);assert.ok(Math.abs(gateElapsed-1.45)<1e-8);assert.ok(maximumStep<.16,`${maximumStep}`);
 assert.ok(['left','right','both'].includes(props.snapshot().props[prop].attachment));props.dispose();
});
test('far standing sources are rejected before the live controller, prop or prior ownership changes',()=>{
 const {c,props}=fixture({table:true,book:{visible:true,attachment:'table',position:[0,9.184839916,30],rotation:[-Math.PI/2,Math.PI/2,0],openness:0}});
 const old=copy(c.snapshot()),physical=props.snapshot();const result=c.preparePlay('take_book_standing',{context:{deskLayout:'partitioned'}});
 assert.equal(result.accepted,false);assert.equal(result.reason,'actual_prop_grip_unreachable');assert.deepEqual(c.snapshot(),old);assert.deepEqual(props.snapshot(),physical);props.dispose();
});
test('near-edge standing sources preserve the original source pose even with partitioned furniture declared',()=>{
 const {c,props}=fixture({table:true,book:{visible:true,attachment:'table',position:[0,9.065,3.3],openness:.8}});
 const base={...c.context,sceneProps:c.sceneProps,initialProps:c.sceneProps,initialPose:c.pose,initialHandAnchors:c.handAnchors(),activityAnchor:c.anchor};
 for(const t of [0,.4,1.15,1.45])assert.deepEqual(sampleActivity('take_book_standing',t,{...base,deskLayout:'partitioned'}),sampleActivity('take_book_standing',t,base));props.dispose();
});
for(const id of ['book','mug'])test(`standing ${id} can return to its real back-desk support without a timed ownership shortcut`,()=>{
 const {c,props}=fixture({table:true,[id]:copy(PARTITIONED_DESK.setupProps[id])});const target=copy(props.snapshot().props[id].position);let receipt=null;
 function run(action){assert.equal(c.play(action,{context:{deskLayout:'partitioned'}}),true);for(let i=0;i<600&&!c.done;i++){
  c.update(c.now+1/60,1/60);const hands=c.handAnchors();props.update({...c.sceneProps,...c.pose.props},{anchors:{leftHand:hands.L,rightHand:hands.R},root:c.root,anchor:c.pose.anchor??c.anchor,pose:c.pose,snapshot:c.snapshot(),time:c.now});
  const row=props.snapshot().props[id];if(row.transfer?.released&&row.transfer.operation==='place'){receipt=copy(row.transfer);assert.equal(receipt.footprint,true);assert.ok(receipt.heightError<.045);assert.ok(receipt.positionError<.09);assert.ok(receipt.relativeSpeed<.32);}
  assert.ok(c.diagnostics.legs.L.error<1e-6&&c.diagnostics.legs.R.error<1e-6);c.setRenderedPropsSnapshot(props.snapshot());c.setPropTransferReceipts(props.snapshot());
 }assert.equal(c.done,true,c.status);}
 run(`take_${id}_standing`);run(`put_${id}_standing`);assert.ok(receipt);assert.equal(props.snapshot().props[id].attachment,'table');assert.ok(distance(props.snapshot().props[id].position,target)<1e-7);props.dispose();
});
