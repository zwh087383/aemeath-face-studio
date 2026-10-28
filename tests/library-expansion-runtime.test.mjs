import test from 'node:test';
import assert from 'node:assert/strict';
import { BehaviorResourceCache } from '../realtime/character-center/resource-cache.mjs';
import { CharacterBodyDirector, bodyAdmission } from '../realtime/character-center/body-director.mjs';
import { CHARACTER_CATALOG } from '../realtime/character-center/catalog.mjs';

const flush=()=>new Promise(resolve=>setImmediate(resolve));
test('default scheduling preserves the browser host receiver for both timer methods',async()=>{
  const schedule=globalThis.setTimeout,clear=globalThis.clearTimeout;let scheduled=false,cleared=false;
  try {
    globalThis.setTimeout=function(callback,delay){assert.equal(this,globalThis);scheduled=true;return Reflect.apply(schedule,globalThis,[callback,delay]);};
    globalThis.clearTimeout=function(timer){assert.equal(this,globalThis);cleared=true;return Reflect.apply(clear,globalThis,[timer]);};
    const cache=new BehaviorResourceCache(async id=>({id}));assert.deepEqual(await cache.prepare('host'),{id:'host'});
    assert.equal(scheduled,true);assert.equal(cleared,true);
  }finally{globalThis.setTimeout=schedule;globalThis.clearTimeout=clear;}
});
test('resource failure is isolated and duplicate preparation shares one result',async()=>{
  const calls=[];const cache=new BehaviorResourceCache(async id=>{calls.push(id);if(id==='broken')throw Error('missing phase');return {id};});
  assert.equal(cache.prepare('valid'),cache.prepare('valid'));await cache.prepare('valid');
  await assert.rejects(cache.prepare('broken'),/missing phase/);
  assert.deepEqual(cache.get('valid'),{id:'valid'});assert.equal(cache.status('valid').state,'ready');assert.equal(cache.status('broken').state,'failed');
  assert.deepEqual(calls,['valid','broken']);
});
function fixture(options={}){let resolve;const calls=[];let state={support:'standing',hands:'free',contacts:{L:true,R:true},props:{}};
  const adapter={canYield:()=>true,prepare:()=>new Promise(r=>resolve=r),start:(d,r)=>{calls.push(r.id);return true;},status:()=>({started:true,done:false}),cancel:()=>{}};
  const idle={canYield:()=>true,start:()=>true,status:()=>({done:true})};
  const director=new CharacterBodyDirector({executors:{conversation:idle,native:adapter,face:idle,activity:idle},getActorState:()=>state,...options});
  return {director,calls,resolve:()=>resolve(),state:s=>state=s};
}
const owner={sourceKey:'test:a',sourceScope:'component',activityId:'a',sourceVersion:1,requestId:'test-1'};
const command={operation:'append',actions:[{action:'native:thinking01',anchor:'immediate'}]};
test('cancelled asynchronous preparation cannot acquire the display later',async()=>{
  const f=fixture();f.director.submit(command,owner);f.director.update(0,0);await flush();
  assert.equal(f.director.pending[0].preparation,'loading');assert.equal(f.calls.length,0);
  f.director.cancel(owner);f.resolve();await flush();f.director.update(.1,.1);
  assert.equal(f.calls.length,0);assert.equal(f.director.pending.length,0);assert.equal(f.director.rows[0].status,'cancelled');
});

test('a hung resource has a wall-time deadline, retires dependents and cannot revive after a late result',async()=>{
  let wall=0;const f=fixture({wallClock:()=>wall,preparationTimeoutMs:1000});
  f.director.submit({...command,actions:[...command.actions,{action:'gesture:wave',anchor:'immediate'}]},owner);
  f.director.submit({operation:'append',actions:[{action:'gesture:wave',anchor:'immediate'}]},
    {...owner,sourceKey:'test:other',requestId:'independent'});
  f.director.update(0,0);await flush();
  f.director.update(600,600);assert.equal(f.director.pending.length,3,'simulation or long playback is not the preparation wall clock');
  wall=1001;f.director.update(600.1,.1);
  assert.equal(f.director.rows[0].reason,'resource_preparation_timeout');
  assert.equal(f.director.rows[1].reason,'dependency_preparation_timeout');
  assert.equal(f.director.active.owner.sourceKey,'test:other');
  f.resolve();await flush();f.director.update(600.2,.1);
  assert.equal(f.calls.length,0);assert.equal(f.director.rows[0].status,'rejected');
  assert.equal(f.director.rows[0].preparation,'failed');
});

test('a stalled asynchronous geometry check releases its queue without imposing an activity duration limit',async()=>{
  let wall=0;const f=fixture({wallClock:()=>wall,preparationTimeoutMs:1000});
  f.director.executors.native.check=()=>({wait:true});
  f.director.submit(command,owner);f.director.update(0,0);await flush();f.resolve();await flush();
  f.director.update(.1,.1);wall=999;f.director.update(1000,.1);assert.equal(f.director.pending.length,1);
  wall=1000;f.director.update(1001,.1);
  assert.equal(f.director.rows[0].reason,'scene_preparation_timeout');assert.equal(f.director.pending.length,0);
  f.director.executors.native.check=()=>null;f.director.update(1002,.1);assert.equal(f.calls.length,0);
});

test('resource timeout aborts its fetch, retains isolated failure and discards a late fulfilled value',async()=>{
  let expire,resolve,signal,wall=0;
  const cache=new BehaviorResourceCache((id,options)=>{
    if(id==='other')return {id};signal=options.signal;return new Promise(r=>resolve=r);
  },{timeoutMs:1000,clock:()=>wall,schedule:callback=>(expire=callback,1),unschedule:()=>{}});
  const pending=cache.prepare('hung');await flush();wall=1001;expire();
  await assert.rejects(pending,/resource_preparation_timeout/);assert.equal(signal.aborted,true);
  resolve({id:'hung'});await flush();assert.equal(cache.status('hung').state,'failed');assert.equal(cache.get('hung'),null);
  assert.deepEqual(await cache.prepare('other'),{id:'other'});
});

test('an overdue successful decode cannot beat the deadline by starving its timer callback',async()=>{
  let wall=0,signal;
  const cache=new BehaviorResourceCache((id,options)=>{signal=options.signal;wall=1001;return {id};},
    {timeoutMs:1000,clock:()=>wall,schedule:()=>1,unschedule:()=>{}});
  await assert.rejects(cache.prepare('late'),/resource_preparation_timeout/);
  assert.equal(signal.aborted,true);assert.equal(cache.status('late').state,'failed');assert.equal(cache.get('late'),null);
  wall=0;const f=fixture({wallClock:()=>wall,preparationTimeoutMs:1000});
  f.director.submit(command,owner);f.director.update(0,0);await flush();wall=1001;f.resolve();await flush();f.director.update(.1,.1);
  assert.equal(f.director.rows[0].status,'rejected');assert.match(f.director.rows[0].reason,/resource_preparation_timeout/);assert.equal(f.calls.length,0);
});
test('resource readiness rechecks actual posture instead of using preparation-time assumptions',async()=>{
  const f=fixture();f.director.submit(command,owner);f.director.update(0,0);await flush();
  f.state({support:'seated',seatSupported:true,hands:'free',contacts:{L:true,R:true},props:{}});f.resolve();await flush();f.director.update(.2,.2);
  assert.equal(f.calls.length,0);assert.equal(f.director.rows[0].reason,'requires_standing');
});
test('catalogue version mismatch does not cancel an accepted plan',()=>{
  const f=fixture();f.director.submit(command,owner);const before=f.director.pending.length;
  assert.equal(f.director.submit({...command,operation:'replace'},{...owner,requestId:'wrong',catalogHash:(CHARACTER_CATALOG.hash??'')+'-wrong'}).reason,'catalog_version_mismatch');
  assert.equal(f.director.pending.length,before);
});
test('per-hand availability preserves an occupied opposite hand',()=>{
  const s={support:'seated',seatSupported:true,hands:'occupied',props:{book:{visible:true,attachment:'left'}}};
  assert.equal(bodyAdmission({requires:{support:'seated',freeHands:['R']}},s),null);
  assert.equal(bodyAdmission({requires:{support:'seated',freeHands:['L']}},s),'requires_free_hand_L');
});

test('asynchronous scene check waits without acquiring the body and rechecks live conditions',async()=>{
  const f=fixture();f.director.executors.native.check=()=>({wait:true,reason:'geometry_preparing'});
  f.director.submit(command,owner);f.director.update(0,0);await flush();f.resolve();await flush();
  for(let i=1;i<5;i++)f.director.update(i*.1,.1);
  assert.equal(f.calls.length,0);assert.equal(f.director.pending.length,1);
  assert.equal(f.director.events.some(e=>e.type==='action_rejected'),false);
  f.state({support:'seated',seatSupported:true,hands:'free',contacts:{L:true,R:true},props:{}});
  f.director.executors.native.check=()=>null;f.director.update(.5,.1);
  assert.equal(f.calls.length,0);assert.equal(f.director.rows[0].reason,'requires_standing');
});

test('lightweight frame snapshots do not clone diagnostic geometry or previous receipts',async()=>{
  const f=fixture();f.director.submit(command,owner);f.director.update(0,0);await flush();f.resolve();await flush();
  f.director.update(.1,.1);f.director.active.nativeEvidence={geometry:[1,2,3]};
  f.director.active.realizedPerformance={phaseData:[{geometry:[1,2,3]}]};
  f.director.active.preparedNative={plan:[{geometry:[4,5,6]}],diagnostics:{samples:80}};
  const light=f.director.update(.2,.1),full=f.director.snapshot();
  assert.equal(light.active.action,'native:thinking01');assert.equal(light.events,undefined);assert.equal(light.rows,undefined);
  assert.equal(light.active.nativeEvidence,undefined);assert.equal(light.active.realizedPerformance,undefined);
  assert.equal(light.active.preparedNative,undefined);
  assert.ok(full.events.length);assert.ok(full.rows.length);assert.deepEqual(full.active.nativeEvidence,{geometry:[1,2,3]});
  light.active.owner.sourceKey='mutated';assert.equal(f.director.active.owner.sourceKey,owner.sourceKey);
});
