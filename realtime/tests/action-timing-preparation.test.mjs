import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {VoicedPreparationClock,VoicedPreparedMotionController,VoicedPreparedFaceController,VoicedActionDriver} from '../action-timing/prep-driver.mjs';
import {skeletonFromInspection} from '../../preview/core/motion-skeleton.js';

test('silent PCM does not release; actual voiced sample preserves phase, initial velocity, and media offset',()=>{
  const c=new VoicedPreparationClock(0,.4);
  c.sample(.4,{status:'playing',time:.3},{reached:false,mediaTime:.5});
  assert.equal(c.release,null);assert.ok(c.raw<.4);
  c.sample(.6,{status:'playing',time:.5},{reached:true,mediaTime:.5,wallTime:.6});
  const raw=c.raw,velocity=c.velocity;
  assert.equal(c.release.media,.5);
  c.sample(.600001,{status:'playing',time:.500001},{reached:true,mediaTime:.5,wallTime:.6});
  assert.ok(Math.abs((c.raw-raw)/.000001-velocity)<.0001);
});
test('pause freezes preparation and its timeout; release freezes during pause and underrun',()=>{
  const c=new VoicedPreparationClock(0,.4);c.sample(.2,{status:'buffering',time:0});const a=c.raw;
  c.sample(10,{status:'paused',time:0});assert.equal(c.raw,a);assert.equal(c.waitAge,.2);
  c.sample(10.1,{status:'playing',time:.5},{reached:true,mediaTime:.5,wallTime:10.1});
  c.sample(10.3,{status:'playing',time:.7});const b=c.raw;
  c.sample(12,{status:'paused',time:.7});assert.equal(c.raw,b);
  c.sample(13,{status:'buffering',time:.7});assert.equal(c.raw,b);
  c.sample(13.1,{status:'playing',time:.8});assert.ok(c.raw>b);
});
const skeleton=skeletonFromInspection(JSON.parse(readFileSync(new URL('../../assets/Aemeath-inspection.json',import.meta.url),'utf8')));
const owner={connectionId:'c',responseId:'r',epoch:1};
function fixture(){
  let wall=0,audio={status:'buffering',time:0},marker=null;
  const motion=new VoicedPreparedMotionController({skeleton}),face=new VoicedPreparedFaceController();
  motion.setOptions({continuity:true});motion.begin(1);face.begin(1);const queued=[];
  const session={motion,face,owner,audio:{snapshot:()=>audio,playbackMarker:()=>marker},enqueue:cue=>{queued.push(cue);return {accepted:true};}};
  const driver=new VoicedActionDriver(session,owner,{clock:()=>wall});
  function step(to,status='buffering',media=0,voice=null){
    const dt=to-wall;wall=to;audio={status,time:media};marker=voice;
    motion.playback(1,status==='buffering'?'paused':status,media);face.playback(1,status==='buffering'?'paused':status,media);
    driver.advance(marker);motion.advancePreparation(wall,audio,marker);face.advancePreparation(wall,audio,marker);
    const paused=status==='paused'||status==='buffering'&&!!marker?.reached;
    face.update(wall,Math.min(dt,1/60),null,false,{mouthMode:'closed',paused});
    motion.update(wall,Math.min(dt,1/60),{face:face.head,paused});
    assert.ok([...face.weights,...[...motion.locals.values()].flat()].every(Number.isFinite));
  }
  return {motion,face,driver,session,queued,step};
}
const event={name:'perform_avatar',callId:'one',responseId:'r',arguments:JSON.stringify({expression:'smile',gesture:'greet'})};
test('same real-skeleton gesture survives voiced handoff, without changing rate or amplitude',()=>{
  const f=fixture();assert.equal(f.driver.accept(event).bodyPrepared,true);
  for(let t=.01;t<=.3;t+=.01)f.step(t,'playing',t,null);
  const g=f.motion.gestures[0],rate=g.rate,strength=g.strength,definition=g.def;
  assert.ok(g.live.age>0&&g.live.age<g.def.prepareEnd);
  f.step(.32,'playing',.32,{reached:true,mediaTime:.31,wallTime:.31});
  for(let t=.33;t<2.3;t+=.01)f.step(t,'playing',t,{reached:true,mediaTime:.31,wallTime:.31});
  assert.equal(f.motion.gestures[0],g);assert.equal(g.rate,rate);assert.equal(g.strength,strength);assert.equal(g.def,definition);
  assert.ok(g.live.age>g.def.prepareEnd);
});
test('explicit pause freezes prepared expression, including time spent paused before first voice',()=>{
  const f=fixture();f.driver.accept(event);for(let t=.01;t<.2;t+=.01)f.step(t);
  f.step(.21,'paused');const weights=Array.from(f.face.weights),age=f.face.preparation.age;
  for(let t=.22;t<4;t+=.02)f.step(t,'paused');
  assert.deepEqual(Array.from(f.face.weights),weights);assert.equal(f.face.preparation.age,age);
  f.step(4.01);assert.ok(f.face.preparation);assert.ok(f.face.preparation.age<.3);
});
test('immediate cancellation deletes pending wall cues; malformed, stale and late commands cannot revive',()=>{
  const f=fixture();assert.equal(f.driver.accept({...event,arguments:'{"expression":'}).accepted,false);
  assert.equal(f.driver.accept({...event,responseId:'old'}).accepted,false);
  assert.equal(f.driver.accept(event).accepted,true);assert.equal(f.motion.pending.length,1);
  f.driver.cancel();f.motion.cancel(1,0);f.face.cancel(1);
  assert.equal(f.motion.pending.length,0);assert.equal(f.face.cues.length,0);
  assert.equal(f.driver.accept({...event,callId:'late'}).accepted,false);
  for(let t=.01;t<1;t+=.01)f.step(t,'cancelled');assert.equal(f.motion.gestures.length,0);
});
test('short reactions wait for voiced sample and never queue on initial silent PCM',()=>{
  const f=fixture();f.driver.accept({...event,arguments:JSON.stringify({expression:'focus',gesture:'nod'})});
  f.step(.2,'playing',.2,{reached:false,mediaTime:.4});assert.equal(f.queued.length,0);
  f.step(.41,'playing',.41,{reached:true,mediaTime:.4,wallTime:.4});assert.equal(f.queued.length,1);assert.equal(f.queued[0].at,.41);
  f.step(.42,'playing',.42,{reached:true,mediaTime:.4,wallTime:.4});assert.equal(f.queued.length,1);
});
test('tool-only preparation retracts after bounded active wait without starting stroke',()=>{
  const f=fixture();f.driver.accept(event);
  for(let t=.01;t<2.7;t+=.01)f.step(t);
  assert.ok(f.motion.gestures.every(g=>g.recovering));assert.equal(f.face.preparation,null);
});
