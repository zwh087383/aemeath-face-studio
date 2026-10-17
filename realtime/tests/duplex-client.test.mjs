import test from 'node:test';
import assert from 'node:assert/strict';
import { DuplexClient } from '../duplex/client.mjs';

function setup(){
  let time=1000;const sent=[],cues=[];
  const audio={status:'buffering',time:0,receivedDuration:0,queuedSeconds:0,sourceCount:0,sourceActive:false,sampleRate:24000,finished:false,epoch:1};
  const session={owner:null,motion:{snapshot:()=>({gestures:[{id:'wave'}]})},audio:{snapshot:()=>({...audio})},
    setConnection:()=>true,beginResponse:o=>(session.owner={...o,epoch:1}),
    appendPcm:({samples})=>{audio.sourceCount++;audio.receivedDuration+=samples.length/24000;return true;},
    finishAudio:()=>{audio.finished=true;return true;},providerDone:()=>true,
    enqueue:cue=>{cues.push(cue);return {accepted:true};},
    pause:()=>{audio.status='paused';audio.sourceCount=0;return true;},resume:async()=>{audio.status='playing';return true;},
    cancel:()=>{audio.status='cancelled';audio.sourceCount=0;audio.queuedSeconds=0;return true;},sync:()=>({...audio})};
  const client=new DuplexClient({session,clock:()=>time});client.socket={readyState:1,send:s=>sent.push(JSON.parse(s))};
  const event=(type,fields={})=>client.message({connectionId:'c',type,turnId:'t',...fields});
  event('ready',{budget:{},listenerConfiguration:{turn_detection:{type:'smart_turn'}}});
  event('turn_started',{text:'问题'});event('request_sent',{providerConnectionId:'p'});event('response_created',{responseId:'r',providerConnectionId:'p'});
  return {client,session,audio,event,sent,cues,advance:n=>time+=n};
}
const pcm=Buffer.alloc(480,32).toString('base64');
const tool={responseId:'r',name:'perform_avatar',callId:'call',arguments:'{"expression":"smile","gesture":"wave"}'};
test('D native tool shares audio owner and never requires subtitle decisions',()=>{
  const f=setup();f.event('audio',{responseId:'r',pcm});f.event('tool',tool);
  assert.equal(f.client.current.frames,240);assert.equal(f.cues.length,2);
  assert.equal(f.cues[1].gesture,'wave');assert.equal(f.cues[1].strength,.65);
});
test('barge-in drops late tools and PCM while preserving generated frame accounting',()=>{
  const f=setup();f.event('audio',{responseId:'r',pcm});assert.equal(f.client.cancel(),true);
  f.event('tool',tool);f.event('audio',{responseId:'r',pcm,revoked:true});
  assert.equal(f.cues.length,0);assert.equal(f.client.current.frames,480);assert.equal(f.client.current.droppedPcm,240);
  assert.equal(f.audio.sourceCount,0);assert.equal(f.sent.filter(e=>e.type==='cancel').length,1);
});
test('noise provisional pause can resume, semantic valid turn irreversibly revokes',async()=>{
  const f=setup();f.audio.status='playing';f.event('speech_started',{itemId:'n'});
  assert.equal(f.audio.status,'paused');assert.equal(f.client.current.revoked,false);
  f.event('speech_stopped',{itemId:'n',valid:false});await Promise.resolve();
  assert.equal(f.audio.status,'playing');assert.equal(f.client.current.revoked,false);
  f.event('speech_started',{itemId:'u'});f.event('speech_stopped',{itemId:'u',valid:true});
  assert.equal(f.client.current.revoked,true);assert.equal(f.audio.status,'cancelled');
});
test('input continues during playback and is never inserted into output audio queue',()=>{
  const f=setup();f.audio.status='playing';const before=f.client.current.frames;
  f.client.sendAudio(new Int16Array(1600).fill(3000));
  assert.equal(f.sent.at(-1).type,'audio');assert.equal(f.client.current.frames,before);
  assert.equal(f.client.sequence,1);assert.equal(f.audio.status,'paused');
});
test('unconfirmed local noise resumes, provider-confirmed speech stays paused',async()=>{
  const f=setup();f.audio.status='playing';f.client.sendAudio(new Int16Array(1600).fill(3000));
  f.advance(1801);f.client.sync();await Promise.resolve();
  assert.equal(f.audio.status,'playing');assert.equal(f.client.current.revoked,false);
  f.event('speech_started',{itemId:'confirmed'});f.advance(2000);f.client.sync();await Promise.resolve();
  assert.equal(f.audio.status,'paused');assert.equal(f.client.current.revoked,false);
});
test('provider done alone cannot settle; final exact playback sends one ACK',()=>{
  const f=setup();f.event('audio',{responseId:'r',pcm});
  const result={connectionId:'p',responseId:'r',frames:240,status:'completed',audioDone:true,transcriptDone:true};
  f.event('response_done',{result});f.event('delivery',{deliveryId:'d',responseId:'r',providerConnectionId:'p',expectedFrames:240});
  assert.equal(f.sent.length,0);
  Object.assign(f.audio,{status:'ended',finished:true,sourceActive:false,sourceCount:0,time:.01,receivedDuration:.01});
  f.client.sync();f.client.sync();assert.equal(f.sent.filter(e=>e.type==='playback_complete').length,1);
});
test('cancellation after generation still rejects later delivery ACK',()=>{
  const f=setup();f.event('audio',{responseId:'r',pcm});f.client.cancel();
  f.event('response_done',{result:{connectionId:'p',responseId:'r',frames:240,status:'completed',audioDone:true,transcriptDone:true}});
  f.event('delivery',{deliveryId:'d',responseId:'r',providerConnectionId:'p',expectedFrames:240});
  Object.assign(f.audio,{status:'ended',finished:true,sourceCount:0,time:.01,receivedDuration:.01});f.client.sync();
  assert.equal(f.sent.filter(e=>e.type==='playback_complete').length,0);
});
test('provider identity conflict is rejected before speech or history side effects',()=>{
  const f=setup();assert.throws(()=>f.event('audio',{responseId:'other',pcm}),/owner_conflict/);
  assert.throws(()=>f.event('delivery',{responseId:'r',providerConnectionId:'other',deliveryId:'d'}),/owner_conflict/);
  assert.equal(f.audio.sourceCount,0);assert.equal(f.sent.length,0);
});
test('input cap stops capture admission but lets the final reply play and settle',()=>{
  const f=setup();f.audio.status='playing';f.event('input_exhausted');
  assert.equal(f.client.sendAudio(new Int16Array(1600)),false);
  assert.equal(f.client.current.revoked,false);assert.equal(f.client.blocked,false);
  f.event('audio',{responseId:'r',pcm});assert.equal(f.client.current.frames,240);
});
