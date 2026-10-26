import test from 'node:test';
import assert from 'node:assert/strict';
import {captureOwnedVoice,compactReport} from '../realtime/character-center/measurement.mjs';
test('previous audio marker cannot be mistaken for the next turn first voice',()=>{
  const previous={epoch:1}, current={epoch:2};
  const t={requestAt:2000,owner:null};
  const session={owner:previous,audio:{context:{currentTime:3},snapshot:()=>({epoch:1}),playbackMarker:()=>({reached:true,contextTime:1})}};
  const client={current:t,session};assert.equal(captureOwnedVoice(client,3000),false);assert.equal(t.voiceAt,undefined);
  t.owner=current;assert.equal(captureOwnedVoice(client,3000),false);
  session.owner=current;session.audio.snapshot=()=>({epoch:2});session.audio.playbackMarker=()=>({reached:true,contextTime:2.8});
  assert.equal(captureOwnedVoice(client,3000),true);assert.equal(t.voiceAt,2800);
});
test('client evidence compaction keeps math and semantic events without mutating raw input',()=>{
 const raw={events:[{type:'character_math',state:{emotion:{V:.2},actorState:{bones:[1]}}},{type:'character_actions',command:{actions:[]}}]};
 const result=compactReport(raw);assert.equal(raw.events[0].state.actorState.bones[0],1);
 assert.equal(result.events[0].state.actorState,undefined);assert.deepEqual(result.events[0].state.emotion,{V:.2});assert.equal(result.events[1],raw.events[1]);
});
