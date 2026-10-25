import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {ModelActionDirector} from '../model-director/director.mjs';
import {ModelMotionController,ModelFaceController} from '../model-director/driver.mjs';
import {ModelDuplexClient} from '../model-director/client.mjs';
import {MODEL_ACTIONS} from '../model-director/catalog.mjs';
import {RealtimeScheduler} from '../scheduler.mjs';
import {AVATAR_CATALOG,createAvatarSink} from '../avatar/controller-bridge.mjs';
import {skeletonFromInspection} from '../../preview/core/motion-skeleton.js';

const skeleton=skeletonFromInspection(JSON.parse(readFileSync(new URL('../../assets/Aemeath-inspection.json',import.meta.url),'utf8')));
const state={authority:'mathematical',source:'wai.state_bus/runtime_soul',contextGeneration:1,
  emotion:{V:-.6,A:.5,D:.5,S:.2,L:.5,T:.5},effectiveEnergy:.01,
  actorState:{posture:'standing',hands:'free',activity:'none'}};
const sequence=['gesture:wave','action:nod','gesture:explain','gesture:micro_ack','action:glance_left','gesture:wave'];
const command=(actions=sequence,operation='append')=>({operation,actions:actions.map(action=>({action,anchor:'prepare',delay_ms:0}))});
function fixture(){
  let wall=0,serial=0,marker=null,audioState={status:'buffering',time:0,epoch:1,sourceActive:false,sourceCount:0};
  const motion=new ModelMotionController({skeleton,seed:42}),face=new ModelFaceController();
  motion.setOptions({continuity:true,natural:true,intensity:1,speed:1});
  const audio={snapshot:()=>({...audioState}),playbackMarker:()=>marker,cancel(){audioState.status='cancelled';return true;}};
  const sink=createAvatarSink({audio,face,motion}),owner={connectionId:'c1',responseId:'r1',epoch:1};
  const scheduler=new RealtimeScheduler({clock:()=>wall,catalog:AVATAR_CATALOG,emit:sink});
  const session={owner,motion,face,audio,scheduler};
  const d=new ModelActionDirector({session,clock:()=>wall});d.setConnection('c1');
  d.beginTurn({connectionId:'c1',turnId:'t1',text:'假如我说过“不要动”呢？'});
  d.updateContext({connectionId:'c1',turnId:'t1',...state});
  assert.equal(scheduler.begin(owner),true);assert.equal(d.bindOwner(owner,{turnId:'t1'}),true);
  const offer=(c=command(),overrides={})=>d.offerPlan({connectionId:'c1',turnId:'t1',planId:`plan-${++serial}`,
    plannerConnectionId:'pc1',plannerResponseId:'pr1',sourceRole:'planner',outputFinal:true,contextGeneration:1,command:c,...overrides});
  function run(seconds,status='playing'){
    const end=wall+seconds;
    while(wall<end-1e-8){const dt=Math.min(1/60,end-wall);wall+=dt;
      audioState.status=status;if(status==='playing'){audioState.time+=dt;marker={reached:true,mediaTime:0,wallTime:0};}
      if(['buffering','playing','paused'].includes(scheduler.status))scheduler.playback({...owner,status,time:audioState.time});
      d.advance(audioState,marker);
      const paused=status==='paused'||d.paused;
      face.update(wall,dt,null,false,{mouthMode:'closed',paused});
      motion.update(wall,dt,{face:face.head,actions:face.activeActions,paused});
      assert.ok([...face.weights,...[...motion.locals.values()].flat()].every(Number.isFinite));
    }
  }
  return {d,offer,run,motion,face,session,scheduler,now:()=>wall};
}

test('backend and renderer expose the same 73 executable motion IDs',()=>{
  const data=JSON.parse(readFileSync(new URL('../model-director/catalog.json',import.meta.url),'utf8'));
  assert.deepEqual(data.map(r=>r.id),Object.keys(MODEL_ACTIONS));assert.equal(data.length,73);
  assert.ok(!data.some(x=>/Stand2|attack/i.test(x.id)));
});
test('six ordered actions including repeated wave finish across natural voice end',()=>{
  const f=fixture();assert.equal(f.offer().accepted,true);f.run(.3,'buffering');f.run(3,'playing');f.run(45,'ended');
  assert.equal(f.d.counts.received,6);assert.equal(f.d.counts.completed,6,JSON.stringify(f.d.snapshot()));
  assert.equal(f.d.counts.rejected,0);assert.equal(f.d.hasWork(),false);
  assert.deepEqual(f.d.rows.map(r=>r.action),sequence);assert.equal(f.session.audio.snapshot().status,'ended');
  assert.equal(f.motion.options.speed,1);assert.equal(f.motion.options.intensity,1);
});
test('no one-action, keyword, first-sentence, low-energy or 4096 dedup-count gate',()=>{
  const f=fixture();for(let i=0;i<4100;i++)assert.equal(f.offer(command(['action:nod'])).accepted,true);
  assert.equal(f.d.pending.length,4100);assert.equal(f.d.counts.received,4100);
  f.run(.3);assert.equal(f.d.counts.started,1);assert.equal(f.d.faceState.preset,'disappointed');
  f.d.cancel({turnId:'t1'});assert.equal(f.d.counts.cancelled,4100);
});
test('preparation survives slow voice, keeps same authored instance and never expires at 2.5 seconds',()=>{
  const f=fixture();f.offer(command(['gesture:wave']));f.run(.3,'buffering');const g=f.motion.gestures[0],def=g.def;
  f.run(4,'buffering');assert.equal(f.motion.gestures[0],g);assert.equal(g.recovering,false);
  f.run(1,'playing');assert.equal(f.motion.gestures[0],g);assert.equal(g.def,def);assert.equal(g.strength,.65);
});
test('pause freezes queued model delay and resumes from the same actual gesture',()=>{
  const f=fixture();f.offer();f.run(.5);const g=f.motion.gestures[0],age=f.motion.ageOf(g),elapsed=f.d.elapsed;
  f.run(1,'paused');assert.equal(f.motion.ageOf(g),age);assert.equal(f.d.elapsed,elapsed);
  f.run(.2);assert.ok(f.motion.ageOf(g)>age);
});
test('manual pause also freezes a prepared gesture after speech has naturally ended',()=>{
  const f=fixture();f.offer(command(['gesture:wave']));f.run(.2,'buffering');f.run(.2,'playing');f.run(.3,'ended');
  const g=f.motion.gestures[0],age=f.motion.ageOf(g);f.d.paused=true;f.run(1,'ended');
  assert.equal(f.motion.ageOf(g),age);f.d.paused=false;f.run(.2,'ended');assert.ok(f.motion.ageOf(g)>age);
});
test('clear/replace retract visuals without stopping audio; bad packet is atomic',()=>{
  const f=fixture();f.offer();f.run(.5);assert.equal(f.offer({operation:'append',actions:[{action:'bogus',anchor:'voice',delay_ms:0}]}).accepted,false);
  assert.equal(f.d.counts.received,6);f.offer(command(['gesture:wave'],'replace'));
  assert.equal(f.d.counts.cancelled,6);assert.equal(f.session.audio.snapshot().status,'playing');
  f.run(8);assert.equal(f.d.counts.completed,1);assert.equal(f.d.counts.started,2);
});
test('barge-in clears current and future actions, stale packets cannot revive them',()=>{
  const f=fixture();f.offer();f.run(.5);f.d.cancel({turnId:'t1'});f.scheduler.interrupt({...f.session.owner,reason:'barge_in'});
  assert.equal(f.offer().accepted,false);f.run(4,'cancelled');assert.equal(f.d.hasWork(),false);
  assert.equal(f.motion.gestures.length,0);assert.equal(f.session.audio.snapshot().status,'cancelled');
});
test('duplicate, wrong owner/version and incomplete calls are rejected before playback',()=>{
  const f=fixture();assert.equal(f.offer(command(),{planId:'same'}).accepted,true);
  for(const row of [{planId:'same'},{turnId:'old'},{contextGeneration:0},{sourceRole:'voice'},{outputFinal:false}])
    assert.equal(f.offer(command(),row).accepted,false);
  assert.equal(f.d.counts.received,6);
});
test('a second valid call can append after voice completed; no action expiry',()=>{
  const f=fixture();f.run(.1);f.run(5,'ended');assert.equal(f.offer(command(['action:shake'])).accepted,true);
  f.run(3,'ended');assert.equal(f.d.counts.completed,1);
});
test('all 73 exposed motions reach the existing controllers and complete with finite bone values',()=>{
  const f=fixture();f.offer(command(Object.keys(MODEL_ACTIONS)));f.run(.1);f.run(650,'ended');
  assert.equal(f.d.counts.completed,73,JSON.stringify(f.d.snapshot()));assert.equal(f.d.counts.rejected,0);
});
test('unknown execution scene waits visibly instead of inventing posture or dropping commands',()=>{
  const f=fixture();f.d.updateContext({connectionId:'c1',turnId:'t1',...state,actorState:{posture:'unknown',hands:'free',activity:'none'}});
  f.offer(command(['gesture:wave']));f.run(1);assert.equal(f.d.pending[0].reason,'execution_scene_unavailable');
  assert.equal(f.d.counts.started,0);f.d.updateContext({connectionId:'c1',turnId:'t1',...state});
  f.run(8);assert.equal(f.d.counts.completed,1);
});
test('renderer refusal never stops speech or fabricates a completed movement',()=>{
  const f=fixture();f.motion.enqueue=()=>false;f.offer(command(['gesture:wave']));f.run(.1);
  assert.equal(f.d.rows[0].status,'execution_failed');assert.equal(f.d.counts.completed,0);
  assert.equal(f.session.audio.snapshot().status,'playing');assert.equal(f.scheduler.fault,null);
});
test('visual-tail interruption preserves completed history instead of revoking delivery',()=>{
  const calls=[],session={owner:{epoch:1},cancel:reason=>calls.push(reason)},director={cancel:x=>calls.push(x),hasWork:()=>true};
  const client=new ModelDuplexClient({session,director});
  client.current={id:'t',settledAt:10,owner:session.owner,revoked:false};
  assert.equal(client.cancel('new_turn',false),true);assert.equal(client.current.revoked,false);
  assert.equal(client.current.settledAt,10);assert.equal(calls.length,2);
});
