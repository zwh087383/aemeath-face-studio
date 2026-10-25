import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {ParallelActionDirector,immediateIntentEvidence,replyConfirms,mathematicalFace} from '../parallel-duplex/director.mjs';
import {VoicedPreparedMotionController,VoicedPreparedFaceController} from '../action-timing/prep-driver.mjs';
import {RealtimeScheduler} from '../scheduler.mjs';
import {AVATAR_CATALOG,createAvatarSink} from '../avatar/controller-bridge.mjs';
import {skeletonFromInspection} from '../../preview/core/motion-skeleton.js';

const skeleton=skeletonFromInspection(JSON.parse(readFileSync(new URL('../../assets/Aemeath-inspection.json',import.meta.url),'utf8')));
const actor={posture:'standing',hands:'free',activity:'none'};
const mathematical={authority:'mathematical',source:'wai.state_bus/runtime_soul',emotion:{V:.4,A:.5,D:.5,S:.2,L:.5,T:.5},effectiveEnergy:.7};

function fixture({text='回来啦，轻快地挥挥手，打个招呼。',actorState=actor,bind=true,context=true,onDecision}={}){
  let wall=0,epoch=0,turnId='t1',generation=1;
  let audioState={status:'buffering',time:0,epoch:0,sourceActive:false,sourceCount:0},marker=null;
  const motion=new VoicedPreparedMotionController({skeleton,seed:42}),face=new VoicedPreparedFaceController();
  motion.setOptions({continuity:true,natural:true,intensity:1,speed:1});
  const audio={snapshot:()=>({...audioState}),playbackMarker:()=>marker,cancel(){audioState={...audioState,status:'cancelled',sourceActive:false,sourceCount:0};}};
  const emitted=[],sink=createAvatarSink({audio,face,motion});
  const scheduler=new RealtimeScheduler({clock:()=>wall,catalog:AVATAR_CATALOG,emit:c=>{emitted.push(c);return sink(c);}});
  const session={motion,face,audio,scheduler,owner:null,enqueue:(cue,owner)=>scheduler.enqueue({...cue,...owner}),snapshot:()=>({revoked:audioState.status==='cancelled'})};
  const director=new ParallelActionDirector({session,clock:()=>wall,onDecision});
  director.setConnection('c1');
  function putContext(overrides={}){return director.updateContext({connectionId:'c1',turnId,userText:text,actorState,contextGeneration:generation,...mathematical,...overrides});}
  function bindOwner(){
    const owner={connectionId:'c1',responseId:`r${++epoch}`,epoch};
    assert.equal(scheduler.begin(owner),true);audioState={...audioState,epoch,status:'buffering',time:0};session.owner=owner;
    assert.equal(director.bindOwner(owner,{turnId}),true);return owner;
  }
  function turn(id,{userText=text,actor=actorState,bind=true,context=true}={}){
    turnId=id;text=userText;actorState=actor;
    assert.equal(director.beginTurn({connectionId:'c1',turnId,text,actorState}),true);
    if(context)putContext();if(bind)bindOwner();
  }
  turn(turnId,{bind,context});
  function plan(intent='greet',overrides={}){return {connectionId:'c1',turnId,planId:`plan-${turnId}`,plannerConnectionId:'p-c1',plannerResponseId:`p-${turnId}`,
    sourceRole:'planner',intent,arguments:JSON.stringify({intent}),contextGeneration:generation,expiresInMs:3500,outputFinal:true,...overrides};}
  function step(to,status='buffering',media=audioState.time,voice=marker){
    const dt=Math.max(0,to-wall);wall=to;audioState={...audioState,status,time:media};marker=voice;
    if(['buffering','playing','paused','ended'].includes(status)&&scheduler.identity)scheduler.playback({...session.owner,status,time:media});
    director.advance(audioState,marker);
    const paused=status==='paused'||status==='buffering'&&!!marker?.reached;
    face.update(wall,Math.min(dt,1/60),null,false,{mouthMode:'closed',paused});
    motion.update(wall,Math.min(dt,1/60),{face:face.head,actions:face.activeActions,paused});
    assert.ok([...face.weights,...[...motion.locals.values()].flat()].every(Number.isFinite));
  }
  function run(duration,status='buffering',voice=null){const end=wall+duration;while(wall+1e-8<end){const dt=Math.min(.01,end-wall);step(wall+dt,status,status==='playing'?audioState.time+dt:audioState.time,voice);}}
  function cancel(reason='barge_in'){director.cancel({turnId,reason});if(scheduler.status!=='ended')scheduler.interrupt({...session.owner,reason});else{motion.retract(wall);face.cancel(epoch);audio.cancel();}}
  return {director,motion,face,session,scheduler,emitted,plan,step,run,cancel,putContext,bindOwner,turn,
    now:()=>wall,marker:()=>marker,audio:()=>audioState,setGeneration:n=>generation=n};
}

test('real PMX support, hand availability and original authored preparation all admit',()=>{
  const f=fixture();
  assert.equal(f.motion.snapshot().support.planted,true);assert.ok(f.motion.snapshot().support.error<=.03);
  assert.equal(f.director.offerPlan(f.plan()).accepted,true);f.run(.2);
  const s=f.director.snapshot(),g=f.motion.gestures[0];
  assert.equal(s.selected.gesture,'wave');assert.equal(s.execution.bodyPrepared,true);assert.ok(g?.live.age>0);
  assert.ok(g.live.age<g.def.prepareEnd);assert.equal(g.strength,.65);assert.equal(f.motion.options.speed,1);assert.equal(f.motion.options.intensity,1);
  assert.equal(f.scheduler.counts.accepted,0,'early route has explicit director reservation, not media queue');
  assert.ok(s.cooldowns.wave>f.now(),'cooldown begins after controller progress');
});

test('same prepared instance crosses actual first voiced sample, not initial silent PCM',()=>{
  const f=fixture();f.director.offerPlan(f.plan());f.run(.15);
  const g=f.motion.gestures[0],rate=g.rate,def=g.def,strength=g.strength;
  f.step(.2,'playing',.2,{reached:false,mediaTime:.5});assert.equal(f.motion.preparationSnapshot()[0].released,false);
  f.step(.5,'playing',.5,{reached:true,mediaTime:.5,wallTime:.5});f.run(.8,'playing',{reached:true,mediaTime:.5,wallTime:.5});
  assert.equal(f.motion.gestures[0],g);assert.equal(g.rate,rate);assert.equal(g.def,def);assert.equal(g.strength,strength);
  assert.ok(g.live.age>g.def.prepareEnd);assert.equal(f.motion.preparationSnapshot()[0].released,true);
});

test('planner arrival before voice owner is held; no voice wait is created',()=>{
  const f=fixture({bind:false});f.director.offerPlan(f.plan());f.step(.1);
  assert.equal(f.motion.pending.length,0);assert.equal(f.director.snapshot().pending.reason,'waiting_for_voice_owner');
  f.bindOwner();f.run(.1);assert.equal(f.director.snapshot().execution.prepared,true);
});

test('malformed, foreign, stale, duplicate and extra-field plans never execute',()=>{
  const f=fixture();
  for(const patch of [{connectionId:'old'},{turnId:'old'},{sourceRole:'voice'},{outputFinal:false},{contextGeneration:0},
    {arguments:'{"intent":'},{arguments:'{"intent":"greet","expression":"happy"}'},
    {intent:'native:8b2e802a90db3da3',arguments:'{"intent":"native:8b2e802a90db3da3"}'},
    {intent:'body-stand2-84d0c0a158',arguments:'{"intent":"body-stand2-84d0c0a158"}'}])assert.equal(f.director.offerPlan(f.plan('greet',patch)).accepted,false);
  assert.equal(f.director.offerPlan(f.plan()).accepted,true);assert.equal(f.director.offerPlan(f.plan()).accepted,false);f.run(.1);
  assert.equal(f.motion.gestures.length,1);
});

test('unknown posture, occupied hands, absent support and explicit prohibition fail closed',()=>{
  for(const actorState of [{...actor,posture:'seated'},{...actor,hands:'book'},{...actor,activity:'reading'},{posture:'unknown'}]){
    const f=fixture({actorState});f.director.offerPlan(f.plan());f.run(.1);
    assert.equal(f.director.snapshot().execution,null);assert.ok(f.director.snapshot().decisions.some(x=>x.reason==='unsupported_actor_state'));
  }
  const f=fixture();f.motion.rig.support=null;f.director.offerPlan(f.plan());f.run(.05);assert.equal(f.motion.gestures.length,0);
  const no=fixture({text:'不要挥手，只说你好。'});assert.equal(no.director.offerPlan(no.plan()).accepted,false);no.run(.1);assert.equal(no.motion.gestures.length,0);
});

test('a question is not itself a forced thinking or greeting action',()=>{
  const f=fixture({text:'今晚天气好吗？'});f.director.offerPlan(f.plan('greet'));f.run(.3);
  assert.equal(f.motion.gestures.length,0);assert.equal(f.director.snapshot().pending.reason,'user_intent_not_clear');
  assert.equal(immediateIntentEvidence('explain','请比较一下两个方案。'),true);
  assert.equal(immediateIntentEvidence('greet','如果我说“你好”，你会怎么做？'),false);
});

test('answer-dependent nod waits for complete real subtitle and actual voice, then uses real media scheduler',()=>{
  const f=fixture({text:'这个办法可行吗？'});f.director.offerPlan(f.plan('agree'));f.run(.1);
  assert.equal(f.scheduler.counts.accepted,0);
  assert.equal(f.director.subtitle({turnId:'t1',responseId:'old',delta:'是的。'}),false);
  f.director.subtitle({turnId:'t1',responseId:'r1',delta:'是的'});f.run(.1);assert.equal(f.scheduler.counts.accepted,0);
  f.director.subtitle({turnId:'t1',responseId:'r1',delta:'，这样可以。',providerResponseId:'physical-2',providerConnectionId:'full-c',segmentIndex:1});
  f.run(.1);assert.equal(f.scheduler.counts.accepted,0);
  f.step(.4,'playing',.1,{reached:true,mediaTime:.1,wallTime:.4});f.step(.41,'playing',.11,{reached:true,mediaTime:.1,wallTime:.4});
  assert.equal(f.scheduler.counts.accepted,1);assert.equal(f.scheduler.counts.dispatched,1);
  assert.equal(f.motion.snapshot().reactions[0]?.kind,'nod');assert.equal(f.director.snapshot().execution.prepared,false);
  assert.equal(f.director.turn.sourceSegments[0].responseId,'physical-2');
});

test('quoted, negated, hypothetical, ambiguous or incomplete stance cannot nod or shake',()=>{
  for(const text of ['“是的”。','如果是的，我们再谈。','是的，但是不能这么做。','是的？','是的，不过我不同意。','我同意不了。','我同意'])assert.equal(replyConfirms('agree',text),false,text);
  for(const text of ['不是不同意。','我不同意吗？','我不同意，不过也许可以。'])assert.equal(replyConfirms('disagree',text),false,text);
  assert.equal(replyConfirms('agree','是的，这样可以。'),true);assert.equal(replyConfirms('disagree','我不同意，这样不稳妥。'),true);
  assert.equal(replyConfirms('comfort','我理解你，这确实不容易。'),true);
});

test('mathematical mood is read-only; low valence never maps to smiling and planner cannot set mood',()=>{
  const f=fixture(),input={...mathematical,emotion:{...mathematical.emotion,V:-.7,A:.2}};
  const original=structuredClone(input);f.setGeneration(2);f.putContext({...input,contextGeneration:2});
  assert.equal(f.director.snapshot().face.preset,'disappointed');assert.deepEqual(input,original);
  assert.equal(mathematicalFace({...mathematical,authority:'model'}).valid,false);
  assert.equal(mathematicalFace({...mathematical,effectiveEnergy:70}).valid,false);
  assert.equal(mathematicalFace(mathematical).preset,'smile');
  assert.equal(f.director.offerPlan(f.plan('greet',{arguments:'{"intent":"greet","emotion":"happy"}'})).accepted,false);
});

test('low energy skips full gesture without changing trajectory amplitude',()=>{
  const f=fixture();f.setGeneration(2);f.putContext({contextGeneration:2,effectiveEnergy:.1});f.director.offerPlan(f.plan());f.run(.1);
  assert.equal(f.motion.gestures.length,0);assert.equal(f.motion.options.intensity,1);
  assert.ok(f.director.snapshot().decisions.some(x=>x.reason==='energy_incompatible_keep_still'));
});

test('context replacement retracts a real preparation; late old plan cannot revive it',()=>{
  const f=fixture();f.director.offerPlan(f.plan());f.run(.2);assert.equal(f.motion.gestures.length,1);
  f.setGeneration(2);f.putContext({contextGeneration:2,actorState:{...actor,hands:'book'}});
  assert.equal(f.motion.preparationSnapshot().length,0);assert.equal(f.motion.gestures[0].recovering,true);
  assert.equal(f.director.offerPlan(f.plan('greet',{contextGeneration:1,planId:'later'})).accepted,false);
  f.run(1);assert.equal(f.motion.gestures.length,0);
});

test('explicit pause freezes preparation and candidate expiry, then resumes from same phase',()=>{
  const f=fixture();f.director.offerPlan(f.plan());f.run(.2);f.step(.21,'paused');
  const raw=f.motion.preparationSnapshot()[0].raw,age=f.motion.gestures[0].live.age;
  f.run(4,'paused');assert.equal(f.motion.preparationSnapshot()[0].raw,raw);assert.equal(f.motion.gestures[0].live.age,age);
  f.step(4.22,'playing',.1,{reached:true,mediaTime:.1,wallTime:4.22});f.run(.2,'playing',{reached:true,mediaTime:.1,wallTime:4.22});
  assert.ok(f.motion.gestures[0].live.age>age);
  const p=fixture({bind:false});p.director.offerPlan(p.plan());p.run(4,'paused');p.bindOwner();p.run(.1);
  assert.equal(p.director.snapshot().execution.prepared,true);
});

test('barge-in removes pending/prepared cues, retracts, and late callbacks cannot resurrect old turn',()=>{
  const f=fixture();f.director.offerPlan(f.plan());f.run(.2);f.cancel();
  assert.equal(f.motion.pending.length,0);assert.equal(f.motion.preparationSnapshot().length,0);assert.equal(f.motion.gestures[0].recovering,true);
  assert.equal(f.director.offerPlan(f.plan()).accepted,false);assert.equal(f.director.subtitle({turnId:'t1',responseId:'r1',delta:'是的。'}),false);
  f.run(1,'cancelled');assert.equal(f.motion.gestures.length,0);assert.equal(f.director.snapshot().mode,'listening');
  f.turn('t2');assert.equal(f.director.beginTurn({connectionId:'c1',turnId:'t1',text:'你好',actorState:actor}),false);
  assert.equal(f.director.snapshot().turnId,'t2');
});

test('cross-turn cooldown follows actual display, not plan receipt, and never affects voice queue',()=>{
  const f=fixture();f.director.offerPlan(f.plan());f.run(.2);f.cancel();f.run(.8,'cancelled');f.turn('t2');f.director.offerPlan(f.plan());f.run(.1);
  assert.ok(f.director.snapshot().decisions.some(x=>x.reason==='cross_turn_cooldown'));
  assert.equal(f.scheduler.status,'buffering');assert.equal(f.scheduler.fault,null);assert.equal(f.motion.options.speed,1);
});

test('missing planner, none/listen and broken diagnostic observer never delay voice',()=>{
  const f=fixture({onDecision(){throw Error('telemetry');}});f.step(.1,'playing',.1,{reached:true,mediaTime:0,wallTime:0});
  assert.equal(f.director.snapshot().mode,'speaking');assert.equal(f.scheduler.fault,null);
  for(const intent of ['none','listen']){const d=fixture();d.director.offerPlan(d.plan(intent));d.run(.1);assert.equal(d.motion.gestures.length,0);assert.equal(d.director.snapshot().execution.phase,'keeping');}
});

test('tool-only preparation has a bounded retraction instead of hanging in the air',()=>{
  const f=fixture();f.director.offerPlan(f.plan());f.run(3.5);
  assert.equal(f.motion.gestures.length,0);assert.equal(f.director.snapshot().execution.phase,'settled');
});
