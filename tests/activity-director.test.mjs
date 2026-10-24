import test from 'node:test';
import assert from 'node:assert/strict';
import { ActivityDirector } from '../realtime/activities/director.mjs';

const fixture = () => {
  const calls = [], body = { done:false, play(id){calls.push(id);this.done=false;return true;},
    snapshot(){return {done:this.done};}, pause(value){this.paused=value;}, stop(){calls.push('STOP');this.done=true;},
    reset(){calls.push('RESET');this.done=true;this.paused=false;} };
  return {body,calls,director:new ActivityDirector(body)};
};
function advance(d, seconds) { for(let t=0;t<seconds;t+=.05)d.tick((d.wall??0)+.05); }

test('sequence pause freezes its rest deadline and resuming starts only the next activity',()=>{
  const {body,calls,director:d}=fixture();d.playSequence('carry_delivery');d.tick(0);body.done=true;d.tick(.1);d.pause();advance(d,5);
  assert.deepEqual(calls,['pickup_box']);d.pause();advance(d,.4);assert.deepEqual(calls,['pickup_box','carry_box']);
});
test('stop retires all future sequence steps even after the body reports finished landing',()=>{
  const {body,calls,director:d}=fixture();d.playSequence('reading_break');d.tick(0);d.stop();body.done=true;advance(d,10);
  assert.deepEqual(calls,['walk_stop','STOP']);assert.equal(d.snapshot().sequence,null);
});
test('manual replacement retires sequence and invalid replacement does not cancel a valid owner',()=>{
  const {body,calls,director:d}=fixture();d.playSequence('carry_delivery');assert.equal(d.play('constructor'),false);
  assert.ok(d.snapshot().sequence);d.play('jump_vertical');body.done=true;advance(d,8);
  assert.deepEqual(calls,['pickup_box','jump_vertical']);assert.equal(d.snapshot().sequence,null);
});
test('reset retires the sequence and resets the clock without an old step reviving',()=>{
  const {body,calls,director:d}=fixture();d.playSequence('reading_break');d.tick(1);d.pause();d.reset();advance(d,3);
  assert.deepEqual(calls,['walk_stop','RESET']);assert.equal(body.paused,false);assert.equal(d.paused,false);assert.equal(d.snapshot().sequence,null);
});

test('an incompatible held object rejects a whole recipe before changing the current owner',()=>{
  const {body,calls,director:d}=fixture();
  body.props={book:{visible:true,attachment:'both'}};
  body.snapshot=()=>({done:body.done,pose:{props:body.props}});
  assert.equal(d.playSequence('reading_break'),true);
  const generation=d.generation,sequence=d.sequence,previousCalls=[...calls];
  assert.equal(d.playSequence('carry_delivery'),false);
  assert.equal(d.generation,generation);assert.equal(d.sequence,sequence);assert.deepEqual(calls,previousCalls);
  assert.equal(d.snapshot().lastRejection.reason,'hands-occupied');
});

test('an already held first take is explicitly satisfied without dispatching or fabricating acquisition',()=>{
  const {body,calls,director:d}=fixture();
  body.props={box:{visible:true,attachment:'both',worldTransform:{position:[1,10,3],quaternion:[0,0,0,1]}}};
  const before=structuredClone(body.props);
  body.snapshot=()=>({done:body.done,pose:{props:body.props}});
  assert.equal(d.playSequence('carry_delivery'),true);
  assert.deepEqual(calls,['carry_box']);assert.equal(d.sequence.index,1);assert.deepEqual(body.props,before);
  assert.deepEqual(d.events.filter(event=>event.type==='step-satisfied').map(event=>({id:event.id,reason:event.reason})),
    [{id:'pickup_box',reason:'already-held'}]);
  assert.equal(body.propTransferReceipts,undefined);
});

test('an existing incompatible desk layout is rejected without moving or hiding its real objects',()=>{
  const {body,calls,director:d}=fixture();
  body.sceneProps={table:{visible:true,worldTransform:{position:[0,0,4.3],quaternion:[0,0,0,1]}},
    paper:{visible:true,attachment:'table',worldTransform:{position:[0,8.935,3.2],quaternion:[0,0,0,1]}}};
  const before=structuredClone(body.sceneProps);
  assert.equal(d.playSequence('desk_session'),false);assert.deepEqual(calls,[]);assert.equal(d.generation,0);
  assert.deepEqual(body.sceneProps,before);assert.equal(d.snapshot().lastRejection.propId,'paper');
  assert.equal(d.snapshot().lastRejection.reason,'existing-desk-object-outside-supported-zone');
});

test('a recipe forwards the desk context per step along with its explicit initial setup',()=>{
  const {body,calls,director:d}=fixture();
  body.play=(id,options)=>{calls.push(id);body.done=false;body.lastContext=options.context;return true;};
  assert.equal(d.playSequence('desk_session'),true);assert.equal(body.lastContext.deskLayout,'partitioned');
  assert.ok(body.lastContext.sceneSetupProps.paper);d.tick(0);body.done=true;d.tick(.1);advance(d,.5);
  assert.equal(calls.at(-1),'take_pencil_seated');assert.equal(body.lastContext.deskLayout,'partitioned');
  assert.equal(body.lastContext.sceneSetupProps,undefined,'a later step repeated the initial scene setup');
});
