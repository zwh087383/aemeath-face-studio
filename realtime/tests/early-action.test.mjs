import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PreparationClock,PreparedMotionController,PreparedFaceController,EarlyActionDriver} from '../early-action/preparation.mjs';
import {skeletonFromInspection} from '../../preview/core/motion-skeleton.js';

test('preparation stays inside prepare; release preserves phase and velocity, pause freezes',()=>{
  const c=new PreparationClock(0,.4);c.sample(.25,{status:'buffering',time:0});
  const before=c.raw,v=c.velocity;c.sample(.25,{status:'playing',time:0});assert.equal(c.raw,before);
  c.sample(.250001,{status:'playing',time:.000001});assert.ok(Math.abs((c.raw-before)/.000001-v)<.0001);
  c.sample(.5,{status:'playing',time:.25});const frozen=c.raw;c.sample(20,{status:'paused',time:.25});assert.equal(c.raw,frozen);
  const waiting=new PreparationClock(0,.4);waiting.sample(10,{status:'buffering',time:0});assert.ok(waiting.raw<.4);
});
const skeleton=skeletonFromInspection(JSON.parse(readFileSync(new URL('../../assets/Aemeath-inspection.json',import.meta.url),'utf8')));
const owner={connectionId:'c',responseId:'r',epoch:1};
function fixture(){let wall=0,audio={status:'buffering',time:0};const motion=new PreparedMotionController({skeleton}),face=new PreparedFaceController();
  motion.setOptions({continuity:true});motion.begin(1);face.begin(1);const queued=[];
  const session={motion,face,owner,audio:{snapshot:()=>audio},enqueue:cue=>{queued.push(cue);return {accepted:true};}};
  const driver=new EarlyActionDriver(session,owner,{early:true,clock:()=>wall});
  const advance=(until,status='buffering',media=0)=>{while(wall+1e-9<until){wall+=1/120;audio={status,time:media};motion.playback(1,status==='buffering'?'paused':status,media);face.playback(1,status==='buffering'?'paused':status,media);motion.advancePreparation(wall,audio);face.advancePreparation(wall,audio);const weights=face.update(wall,1/120,null,false,{mouthMode:'closed',paused:status==='paused'});motion.update(wall,1/120,{face:face.head,paused:status==='paused'});assert.ok([...weights,...[...motion.locals.values()].flat()].every(Number.isFinite));}};
  return {motion,face,driver,session,queued,advance,get wall(){return wall;}};
}
const event={name:'perform_avatar',callId:'one',responseId:'r',arguments:JSON.stringify({expression:'smile',gesture:'greet'})};
test('real inspection skeleton prepares before audio and releases the SAME authored gesture',()=>{
  const f=fixture();assert.equal(f.driver.accept(event).bodyPrepared,true);f.advance(.25);
  const g=f.motion.gestures[0];assert.equal(g.gesture,'greet');assert.ok(g.live.age>0&&g.live.age<g.def.prepareEnd);
  assert.ok(f.face.weights.some(x=>x>.05));assert.equal(f.queued.length,0);
  f.advance(.27,'playing',0);f.advance(2.3,'playing',2);
  assert.equal(f.motion.gestures.length,1);assert.equal(f.motion.gestures[0],g);assert.ok(g.live.age>g.def.prepareEnd);
});
test('retract from early pose, no resurrection by duplicate, stale, or malformed command',()=>{
  const f=fixture();assert.equal(f.driver.accept({...event,arguments:'{'}).accepted,false);
  assert.equal(f.driver.accept({...event,responseId:'old'}).accepted,false);
  assert.equal(f.driver.accept(event).accepted,true);f.advance(.2);f.driver.cancel();
  f.motion.cancel(1,f.wall);f.face.cancel(1);assert.equal(f.driver.accept(event).accepted,false);
  for(let i=0;i<240;i++)f.motion.update(f.wall+i/60,1/60,{paused:false});
  assert.equal(f.motion.gestures.length,0);
});
test('tool-only timeout unwinds preparation without starting stroke; old owner cannot arm again',()=>{
  const f=fixture();f.driver.accept(event);f.advance(2.6);assert.ok(f.motion.gestures.every(g=>g.recovering));assert.equal(f.face.preparation,null);
  f.session.owner={...owner,epoch:2};assert.equal(f.driver.accept({...event,callId:'two'}).accepted,false);
});
test('none is valid and short nod waits for audio; no invented thinking pose',()=>{
  const f=fixture();assert.equal(f.driver.accept({...event,arguments:JSON.stringify({expression:'neutral',gesture:'none'})}).accepted,true);
  f.advance(.5);assert.equal(f.motion.gestures.length,0);
  const n=fixture();n.driver.accept({...event,arguments:JSON.stringify({expression:'focus',gesture:'nod'})});assert.equal(n.queued[0].action,'nod');assert.equal(n.motion.preparations.size,0);
});
