import test from 'node:test';
import assert from 'node:assert/strict';
import {CharacterCenter} from '../realtime/character-center/center.mjs';

function fixture(){const calls=[];const face={setMathematical:(...x)=>{calls.push(['math',...x]);return true;},setAttitude:x=>{calls.push(['attitude',x]);return true;},react:x=>{calls.push(['react',x]);return true;},clearAttitude:()=>true,cancel:x=>calls.push(['cancelFace',x]),snapshot:()=>({})};
 const body={submit:(...x)=>{calls.push(['body',...x]);return {accepted:true};},cancel:(...x)=>calls.push(['cancelBody',...x]),pause:()=>{},snapshot:()=>({})};
 return {center:new CharacterCenter({face,body,clock:()=>10}),calls};}
const expression=(extra={})=>({type:'character_expression',sourceScope:'user',sourceKey:'user:turn1',sourceVersion:'1',semanticRevision:1,requestId:'q1',turnId:'turn1',mediaAnchor:{kind:'immediate'},command:{mode:'attitude',kind:'serious',strength:.6,evidenceRef:'user:turn1'},...extra});
test('mathematical changes cannot cancel body or discard semantic attitude',()=>{const {center,calls}=fixture();center.beginTurn({turnId:'turn1'});center.message(expression());center.message({type:'character_math',state:{emotion:{V:-.3,A:.5}},mathRevision:5});assert.deepEqual(calls.map(x=>x[0]),['attitude','math']);});
test('assistant expression waits for actual matching played segment',()=>{const {center,calls}=fixture();center.beginTurn({turnId:'turn1'});center.message(expression({sourceKey:'assistant:one',sourceScope:'assistant',mediaAnchor:{kind:'segment_end',turnId:'turn1',segmentIndex:0,providerConnectionId:'c1',responseId:'r1'}}));
 const trial={id:'turn1',owner:{epoch:2},segments:[{index:0,connectionId:'c1',responseId:'r1',startFrame:0,frames:48000,result:{status:'completed',audioDone:true}}]};
 center.advance({time:1.9,epoch:2,status:'playing'},trial);assert.equal(calls.length,0);center.advance({time:2,epoch:2,status:'paused'},trial);assert.equal(calls.length,0);center.advance({time:2,epoch:2,status:'playing'},trial);assert.equal(calls[0][0],'attitude');});
test('cancelled waiting expressions never reappear after playback reaches old segment',()=>{const {center,calls}=fixture();center.beginTurn({turnId:'turn1'});center.message(expression({mediaAnchor:{kind:'segment_end',turnId:'turn1',segmentIndex:0,providerConnectionId:'c1',responseId:'r1'}}));center.cancel({turnId:'turn1'});assert.equal(center.pending.length,0);assert.equal(calls.filter(x=>x[0]==='attitude').length,0);});
test('activity pause rejects old revisions but permits genuinely newer resume',()=>{const {center,calls}=fixture();const event=expression({turnId:null,sourceScope:'activity',sourceKey:'activity:read',activityId:'read'});center.message(event);center.message({type:'character_revoke',sourceKey:'activity:read',reason:'paused'});assert.equal(center.message(event),false);assert.equal(center.message({...event,semanticRevision:2,requestId:'q2'}),true);assert.equal(calls.filter(x=>x[0]==='attitude').length,2);});
test('opaque backend source version is mapped without treating turn ids as numbers',()=>{const {center,calls}=fixture();center.beginTurn({turnId:'turn1'});center.message({...expression(),type:'character_actions',sourceVersion:'opaque:123',command:{operation:'append',actions:[]}});assert.equal(calls[0][2].sourceVersion,1);assert.equal(calls[0][2].sourceRevision,'opaque:123');});

test('streaming audio frontier releases before provider completion and only on its own playing clock',()=>{
 const {center,calls}=fixture();center.beginTurn({turnId:'turn1'});
 center.message(expression({mediaAnchor:{kind:'audio_frame',turnId:'turn1',segmentIndex:0,providerConnectionId:'p',responseId:'r',frame:12000}}));
 const trial={id:'turn1',owner:{epoch:2},segments:[{index:0,connectionId:'p',responseId:'r',startFrame:24000,frames:48000}]};
 for(const audio of [{time:2,epoch:3,status:'playing'},{time:2,epoch:2,status:'paused'},{time:1.49,epoch:2,status:'playing'}])center.advance(audio,trial);
 assert.equal(calls.length,0);center.advance({time:1.5,epoch:2,status:'playing'},trial);
 assert.equal(calls[0][0],'attitude');assert.equal(trial.segments[0].result,undefined);
 assert.equal(center.played.size,0,'expression gate is not a history or complete-playback receipt');
 assert.equal(center.pending.length,0);
});

test('zero audio frontier cannot start before playback and cancelled frontier never returns',()=>{
 const {center,calls}=fixture();center.beginTurn({turnId:'turn1'});
 center.message(expression({mediaAnchor:{kind:'audio_frame',turnId:'turn1',segmentIndex:0,providerConnectionId:'p',responseId:'r',frame:0}}));
 const trial={id:'turn1',owner:{epoch:2},segments:[{index:0,connectionId:'p',responseId:'r',startFrame:0,frames:10000}]};
 center.advance({time:0,epoch:2,status:'playing'},trial);assert.equal(calls.length,0);
 center.cancel({turnId:'turn1'});center.advance({time:.2,epoch:2,status:'playing'},trial);
 assert.equal(calls.filter(x=>x[0]==='attitude').length,0);
});

test('a newer face/subtitle fact retains an existing body lease; revocation really retires it',()=>{
 const {center,calls}=fixture();center.beginTurn({turnId:'turn1'});
 center.message({...expression(),type:'character_actions',command:{operation:'append',actions:[]}});
 const owner=calls[0][2];assert.equal(center.current(owner),true);
 center.message(expression({requestId:'new-face',semanticRevision:2,sourceVersion:'new-text-fact'}));
 assert.equal(center.current(owner),true,'face-only update must not cancel a moving body');
 center.message({type:'character_revoke',sourceKey:'user:turn1',reason:'source_withdrawn'});
 assert.equal(center.current(owner),false);
 center.message(expression({requestId:'new-fact',semanticRevision:3,sourceVersion:'resumed'}));
 assert.equal(center.current(owner),false,'later fact cannot resurrect old body');
});

test('barge-in drops a late higher-revision tool from the old turn without erasing the current attitude',()=>{
 const {center,calls}=fixture();center.beginTurn({turnId:'turn1'});center.message(expression());center.cancel({turnId:'turn1'});
 assert.equal(center.message(expression({requestId:'already-on-wire',semanticRevision:99,sourceVersion:'late'})),false);
 assert.equal(calls.filter(x=>x[0]==='attitude').length,1);
 center.beginTurn({turnId:'turn2'});
 assert.equal(center.message(expression({turnId:'turn2',sourceKey:'user:turn2',requestId:'new-turn',semanticRevision:100})),true);
});
