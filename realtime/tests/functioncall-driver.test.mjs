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
