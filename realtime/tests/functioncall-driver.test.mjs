import test from 'node:test';
import assert from 'node:assert/strict';
import {FunctionCallDriver} from '../qwen/functioncall-driver.mjs';
const event={name:'perform_avatar',callId:'call1',arguments:JSON.stringify({expression:'smile',gesture:'greet',strength:.7,intent:'招呼'})};
function fixture(){const owner={connectionId:'c',responseId:'logical-r',epoch:1},queued=[];let state={status:'buffering',time:0};
  const session={owner,audio:{snapshot:()=>state},enqueue:(cue,identity)=>{assert.equal(identity,owner);queued.push(cue);return {accepted:true};}};
  return {driver:new FunctionCallDriver(session,owner),session,queued,setState:s=>state=s};}
test('complete native plan queues face/body at media zero, without transcript',()=>{const f=fixture();assert.equal(f.driver.accept(event).accepted,true);assert.equal(f.queued.length,2);assert.equal(f.queued[1].gesture,'greet');assert.equal(f.queued[0].at,0);});
test('partial JSON and identity injection never execute',()=>{const f=fixture();assert.equal(f.driver.accept({...event,arguments:'{'}).accepted,false);assert.equal(f.driver.accept({...event,arguments:JSON.stringify({...JSON.parse(event.arguments),epoch:2})}).accepted,false);assert.equal(f.queued.length,0);});
test('duplicate and cancelled calls are rejected',()=>{const f=fixture();f.driver.accept(event);assert.equal(f.driver.accept(event).reason,'duplicate_call');f.driver.cancel();assert.equal(f.driver.accept({...event,callId:'next'}).accepted,false);assert.equal(f.queued.length,2);});
test('replaced owner cannot accept a late event',()=>{const f=fixture();f.session.owner={...f.session.owner,epoch:2};assert.equal(f.driver.accept(event).accepted,false);assert.equal(f.queued.length,0);});
test('late tool uses current actual audio position; ended turn drops it',()=>{const f=fixture();f.setState({status:'playing',time:2});assert.equal(f.driver.accept(event).at,2.06);f.setState({status:'ended',time:3});assert.equal(f.driver.accept({...event,callId:'later'}).reason,'audio_turn_closed');});

test('mid-stream underrun queues face and body at the held media head, not zero',()=>{
  const f=fixture();f.setState({status:'buffering',time:.4});
  assert.equal(f.driver.accept(event).at,.4);assert.deepEqual(f.queued.map(c=>c.at),[.4,.4]);
});
test('immediate tool timing preserves identity and dedup protections without extra audio lead',()=>{
  const f=fixture();f.setState({status:'playing',time:.7});
  const d=new FunctionCallDriver(f.session,f.session.owner,{leadSeconds:0});
  assert.equal(d.accept(event).at,.7);assert.deepEqual(f.queued.map(c=>c.at),[.7,.7]);
  assert.equal(d.accept(event).reason,'duplicate_call');d.cancel();
  assert.equal(d.accept({...event,callId:'new'}).reason,'revoked_or_stale_owner');
});
