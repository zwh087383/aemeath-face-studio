import test from 'node:test';
import assert from 'node:assert/strict';
import {CooutputDriver} from '../qwen/cooutput-driver.mjs';
import {MotionController} from '../../preview/core/motion-controller.js';
import {skeleton} from '../../scripts/check-coordinated-motion.mjs';
const event={name:'perform_avatar',callId:'c1',arguments:JSON.stringify({expression:'smile',gesture:'greet'})};
function fixture(group='D') {
  const owner={connectionId:'conn',responseId:'logical',epoch:1}, calls=[];
  const session={owner,audio:{snapshot:()=>({status:'playing',time:.5})},enqueue:(cue,identity)=>{
    assert.equal(identity,owner); calls.push(cue); return {accepted:true};}};
  return {driver:new CooutputDriver(session,owner,group),calls,session};
}
test('compact native args keep full authored gesture, strength defaults locally',()=>{
  const f=fixture(),r=f.driver.accept(event);assert.equal(r.accepted,true);
  assert.equal(r.at,.56);assert.equal(f.calls[1].gesture,'greet');assert.equal(f.calls[1].strength,.65);
});
test('compact schema rejects partial, extra owner fields and unexpected expressions',()=>{
  for(const args of ['{',JSON.stringify({expression:'smile',gesture:'greet',epoch:1}),JSON.stringify({expression:'thinking',gesture:'greet'})]){
    const f=fixture();assert.equal(f.driver.accept({...event,arguments:args}).accepted,false);assert.equal(f.calls.length,0);
  }
});
test('late native calls after interrupt or replaced response cannot revive motion',()=>{
  const f=fixture();f.driver.accept(event);f.driver.cancel();
  assert.equal(f.driver.accept({...event,callId:'late'}).accepted,false);assert.equal(f.calls.length,2);
  const g=fixture();g.session.owner={...g.session.owner,epoch:2};assert.equal(g.driver.accept(event).accepted,false);
});
test('baseline cannot accidentally execute a native gesture',()=>{
  const f=fixture('A');assert.equal(f.driver.accept(event).accepted,false);assert.equal(f.calls.length,0);
});
test('replaying the same provider call after cancellation executes in a new local epoch',()=>{
  const motion=new MotionController({skeleton}), ids=[];
  for(const epoch of [1,2,3]){
    assert.equal(motion.begin(epoch),true);
    assert.equal(motion.playback(epoch,'playing',0),true);
    const owner={connectionId:`conn${epoch}`,responseId:'saved-logical-id',epoch};
    const session={owner,audio:{snapshot:()=>({status:'buffering',time:0})},enqueue:cue=>({accepted:cue.kind!=='gesture'||motion.enqueue({...cue,epoch,clock:'audio'})})};
    const driver=new CooutputDriver(session,owner,'D');
    const result=driver.accept(event);
    assert.equal(result.accepted,true);
    assert.equal(result.providerCallId,event.callId);
    ids.push(result.localCallId);
    assert.equal(driver.accept(event).reason,'duplicate_call');
    driver.cancel();assert.equal(driver.accept({...event,callId:'late'}).accepted,false);
    assert.equal(motion.cancel(epoch,0),true);
  }
  assert.equal(new Set(ids).size,3);
});
