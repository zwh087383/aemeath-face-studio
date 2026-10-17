import test from 'node:test';
import assert from 'node:assert/strict';
import {loadVariant,makeController,measureAction,readPose} from '../scripts/compare-body-elbows.mjs';

const variant=await loadVariant();
const distance=(a,b)=>Math.hypot(...a.map((v,i)=>v-b[i]));
const measurements=new Map();
const measure=id=>{if(!measurements.has(id))measurements.set(id,measureAction(variant,id));return measurements.get(id);};

test('ordinary gestures no longer retain the accepted baseline excessively lateral elbows',()=>{
  // Actual 63199b1 PMX FK peaks, measured in the chest frame relative to the upper
  // arm joint, not the model origin. High waves are intentionally excluded.
  const before=[['explain','L',1.65],['shy','R',1.80],['think','R',1.76],['comfort','L',1.78],['explain_firm','L',1.74]];
  for(const [id,side,lateral] of before){
    const actual=measure(id).elbows[side];
    assert.ok(actual.expressiveLateral<lateral*.85,`${id}/${side}: ${actual.expressiveLateral.toFixed(3)}u remains near baseline ${lateral}u`);
    assert.ok(actual.peakAbductionDeg<35,`${id}/${side}: ${actual.peakAbductionDeg.toFixed(1)}deg lateral abduction`);
  }
});

test('legacy gestures have visibly scaled torso participation rather than sub-two-degree motion',()=>{
  for(const id of ['explain','wave','shrug','chest']){
    const m=measure(id);
    assert.ok(m.peak.upperChest.rotationDeg>=4,`${id}: chest ${m.peak.upperChest.rotationDeg.toFixed(2)}deg`);
    assert.ok(m.peak.head.translation>=.2,`${id}: head travel ${m.peak.head.translation.toFixed(3)}u`);
  }
});

test('long holds contain authored torso evolution instead of a frozen shoulder-and-hand tableau',()=>{
  for(const id of ['explain','wave','chest']){
    const m=measure(id);
    assert.ok(m.hold.frames>=10,`${id}: no actual hold samples`);
    assert.ok(m.hold.chestRotationRangeDeg>=.7,`${id}: hold chest range ${m.hold.chestRotationRangeDeg.toFixed(3)}deg`);
  }
});

test('all actions preserve finite, bounded elbow and wrist trajectories after pole changes',()=>{
  for(const id of variant.GESTURE_IDS){
    const m=measure(id);
    assert.ok(Number.isFinite(m.elbowSpeed)&&m.elbowSpeed<18,`${id}: elbow speed ${m.elbowSpeed}`);
    assert.ok(Number.isFinite(m.wristSpeed)&&m.wristSpeed<18,`${id}: wrist speed ${m.wristSpeed}`);
    for(const side of ['L','R'])assert.ok(m.elbows[side].peakAbductionDeg<75,`${id}/${side}: excessive lateral abduction`);
  }
});

test('changing or cancelling a live pose never flips an elbow and pause keeps the solved elbows fixed',()=>{
  for(const [first,next]of [['wave','think'],['shy','explain'],['comfort','look_up']]){
    const c=makeController(variant);c.begin(1);c.trigger(first,`first-${first}`,2);
    let now=2,audio=0,previous=readPose(variant,c),maxElbow=0,maxWrist=0;
    const advance=frames=>{for(let i=0;i<frames;i++){
      now+=1/60;if(c.status==='playing'){audio+=1/60;c.playback(1,'playing',audio);}c.update(now,1/60);
      const p=readPose(variant,c);for(const side of ['L','R']){maxElbow=Math.max(maxElbow,distance(p.elbows[side].position,previous.elbows[side].position)*60);maxWrist=Math.max(maxWrist,distance(p.wrists[side],previous.wrists[side])*60);}previous=p;
    }};
    advance(75);c.playback(1,'paused',audio);const paused=readPose(variant,c);advance(45);
    for(const side of ['L','R'])assert.ok(distance(paused.elbows[side].position,previous.elbows[side].position)<.001,`${first}/${side}: elbow moves while paused`);
    c.playback(1,'playing',audio);assert.equal(c.trigger(next,`next-${next}`,now),true);advance(40);assert.equal(c.cancel(1,now),true);advance(200);
    assert.ok(maxElbow<22,`${first}->${next}: elbow speed ${maxElbow}`);
    assert.ok(maxWrist<24,`${first}->${next}: wrist speed ${maxWrist}`);
    assert.equal(c.snapshot().gestures.length,0,'cancel completes');
  }
});
